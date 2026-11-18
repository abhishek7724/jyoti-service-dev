alter table public.invoices
  add column gross_total numeric(12,2),
  add column discount_amount numeric(12,2) not null default 0,
  add column discount_percent numeric(5,2) not null default 0,
  add column rounding_adjustment numeric(12,2) not null default 0,
  add constraint invoices_total_nonnegative check (total >= 0);
alter table public.invoices drop constraint invoices_total_check;

create function public.issue_discounted_service_invoice(
  p_ticket uuid, p_fee numeric, p_tax_rate numeric, p_gstin text, p_issuer jsonb, p_start bigint,
  p_prices jsonb, p_discount_type text, p_discount_value numeric
) returns public.invoices language plpgsql set search_path = '' as $$
declare
  ticket public.service_tickets%rowtype;
  bill public.invoices%rowtype;
  issued date := (statement_timestamp() at time zone 'Asia/Kolkata')::date;
  start_year integer; fy text; n bigint;
  rows jsonb; net numeric; cgst_amount numeric; sgst_amount numeric;
  gross numeric; discount numeric; discount_rate numeric; adjustment numeric;
begin
  select * into strict ticket from public.service_tickets where id = p_ticket for update;
  select * into bill from public.invoices where ticket_id = p_ticket;
  if found then return bill; end if;
  if ticket.status <> 'Repair Complete' then raise exception 'Finish the repair before issuing an invoice'; end if;
  if p_issuer ->> 'name' is distinct from 'JYOTI REFRIGERATION.' then raise exception 'Invoice issuer has not been configured'; end if;

  if p_discount_type is null or p_discount_type not in ('none','percent','fixed')
     or p_discount_value is null or p_discount_value < 0
     or (p_discount_type = 'percent' and p_discount_value > 100) then
    raise exception 'Enter a valid discount';
  end if;
  if jsonb_typeof(p_prices) is distinct from 'array' then raise exception 'Review the invoice prices'; end if;
  if exists (
    select 1 from jsonb_to_recordset(p_prices) as price(item_id uuid, price numeric)
    full join (select item_id from public.ticket_parts where ticket_id = p_ticket) used using (item_id)
    group by coalesce(price.item_id, used.item_id)
    having count(*) <> 1 or count(used.item_id) <> 1
      or count(price.price) <> 1 or min(price.price) < 0 or max(price.price) > 9999999
  ) then
    raise exception 'Parts or prices changed. Reopen the invoice draft and review it again';
  end if;

  with itemized as (
    select i.id::text line_key, i.description, i.hsn_sac, i.uom, p.quantity, price.price unit_price,
      i.tax_rate, round(p.quantity * price.price,2) base
    from public.ticket_parts p join public.items i on i.id = p.item_id
    join jsonb_to_recordset(p_prices) as price(item_id uuid, price numeric) on price.item_id = p.item_id
    where p.ticket_id = p_ticket
    union all
    select 'service','SERVICE CHARGES','9987','Pcs.',1,p_fee,p_tax_rate,round(p_fee,2)
  ),
  original as (
    select *, base + 2 * round(base * tax_rate / 200,2) line_gross from itemized
  ),
  running as (
    select *, sum(line_gross) over () original_total,
      sum(line_gross) over (order by line_key) gross_to_line from original
  ),
  discounts as (
    select *, case p_discount_type when 'percent' then round(original_total*p_discount_value/100,2)
      when 'fixed' then p_discount_value else 0 end discount_total from running
  ),
  allocation as (
    select *, round(discount_total*gross_to_line/nullif(original_total,0),2) -
      round(discount_total*(gross_to_line-line_gross)/nullif(original_total,0),2) line_discount
    from discounts
  ),
  taxable as (
    select *, case when line_discount = 0 then base
      else least(base, round((line_gross-line_discount)/(1+tax_rate/100),2)) end amount
    from allocation
  ),
  taxed as (
    select *, round(amount*tax_rate/200,2) cgst, round(amount*tax_rate/200,2) sgst from taxable
  )
  select jsonb_agg(jsonb_build_object(
    'description',description,'hsn_sac',hsn_sac,'uom',uom,'quantity',quantity,
    'unit_price',unit_price,'tax_rate',tax_rate,'base_before_discount',base,
    'amount',amount,'cgst',cgst,'sgst',sgst
  ) order by line_key = 'service', description, line_key),
    sum(amount),sum(cgst),sum(sgst),max(original_total),max(discount_total)
    into rows,net,cgst_amount,sgst_amount,gross,discount from taxed;
  if gross <= 0 then raise exception 'Invoice total before discount must be positive'; end if;
  if discount > gross then raise exception 'Discount cannot exceed the invoice total'; end if;
  if gross > 9999999999.99 then raise exception 'Invoice total exceeds the supported amount'; end if;
  discount_rate := case when p_discount_type = 'percent' then p_discount_value else round(discount/gross*100,2) end;
  adjustment := gross-discount-net-cgst_amount-sgst_amount;

  start_year := extract(year from issued)::integer - case when extract(month from issued) < 4 then 1 else 0 end;
  fy := start_year::text || '-' || right((start_year + 1)::text,2);
  insert into public.invoice_counters as counters(financial_year,last_number) values(fy,greatest(1,p_start))
  on conflict(financial_year) do update set last_number = counters.last_number + 1 returning last_number into n;

  insert into public.invoices(ticket_id,number,issued_on,customer_name,service_address,customer_gstin,issuer,lines,subtotal,cgst,sgst,total,
    gross_total,discount_amount,discount_percent,rounding_adjustment)
    values(p_ticket,n::text || '/' || fy,issued,ticket.customer_name,
      concat_ws(', ', ticket.service_address,ticket.locality,ticket.city),p_gstin,p_issuer,rows,net,cgst_amount,sgst_amount,gross-discount,
      gross,discount,discount_rate,adjustment)
    returning * into bill;
  return bill;
end
$$;

revoke all on function public.issue_discounted_service_invoice(uuid,numeric,numeric,text,jsonb,bigint,jsonb,text,numeric) from public, anon, authenticated;
grant execute on function public.issue_discounted_service_invoice(uuid,numeric,numeric,text,jsonb,bigint,jsonb,text,numeric) to service_role;
