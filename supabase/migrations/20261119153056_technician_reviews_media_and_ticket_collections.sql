alter table public.service_tickets
  add column inspection_notes text not null default '' check (length(inspection_notes) <= 2000),
  add column completion_notes text not null default '' check (length(completion_notes) <= 2000),
  add column test_result text not null default '' check (length(test_result) <= 1000),
  add column inspected_at timestamptz,
  add column completed_at timestamptz,
  add column customer_view_key uuid not null default gen_random_uuid();
alter table public.service_tickets drop constraint service_tickets_status_check;
alter table public.service_tickets add constraint service_tickets_status_check check (
  status in ('New','Assigned','In Progress','Awaiting Parts','Repair Complete','Paid, not billed','Billed','Paid')
);
alter table public.payments
  add column ticket_id uuid references public.service_tickets(id),
  add column collected_by uuid references public.staff(user_id),
  add column receipt_number bigint generated always as identity (start with 1001) unique,
  add column acknowledgement text not null default '',
  add column signature_waiver text not null default '' check (length(signature_waiver) <= 500);
update public.payments p set ticket_id = i.ticket_id from public.invoices i where i.id = p.invoice_id;
alter table public.payments drop constraint payments_check;
alter table public.payments add constraint payments_destination_check check (
  (supplier_bill_id is not null and invoice_id is null and ticket_id is null)
  or (supplier_bill_id is null and (invoice_id is not null or ticket_id is not null))
);
create index payments_ticket_idx on public.payments(ticket_id);

create table public.ticket_media (
  id uuid primary key,
  ticket_id uuid not null references public.service_tickets(id),
  stage text not null check (stage in ('inspection','completion','payment','signature')),
  object_path text not null unique,
  file_name text not null check (length(file_name) <= 150),
  mime_type text not null check (mime_type in ('image/jpeg','image/png','image/webp')),
  file_size integer not null check (file_size between 1 and 6291456),
  uploaded_by uuid not null references public.staff(user_id),
  created_at timestamptz not null default now(),
  ready boolean not null default false,
  payment_id uuid references public.payments(id)
);
create index ticket_media_ticket_idx on public.ticket_media(ticket_id,created_at);
alter table public.ticket_media enable row level security;
revoke all on public.ticket_media from public,anon,authenticated;
grant select,insert,update,delete on public.ticket_media to service_role;
alter table public.payments
  add column proof_media_id uuid unique references public.ticket_media(id),
  add column signature_media_id uuid unique references public.ticket_media(id);
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('ticket-media','ticket-media',false,6291456,array['image/jpeg','image/png','image/webp']);

grant usage on schema jyoti_private to service_role;
create function jyoti_private.ticket_financial_status(p_ticket uuid) returns text
language plpgsql set search_path='' as $$
declare total_due numeric; received numeric;
begin
  select total into total_due from public.invoices where ticket_id = p_ticket;
  select coalesce(sum(amount),0) into received from public.payments where ticket_id = p_ticket;
  if total_due is not null then
    return case when received >= total_due then 'Paid' else 'Billed' end;
  end if;
  return case when received > 0 then 'Paid, not billed' else 'Repair Complete' end;
end
$$;
revoke all on function jyoti_private.ticket_financial_status(uuid) from public,anon,authenticated;
grant execute on function jyoti_private.ticket_financial_status(uuid) to service_role;

create or replace function jyoti_private.validate_ticket_update() returns trigger
language plpgsql set search_path='' as $$
begin
  if new.assigned_to is distinct from old.assigned_to then
    if (select jyoti_private.staff_role()) is distinct from 'manager' then raise exception 'Only managers can assign tickets'; end if;
    if old.status in ('Repair Complete','Paid, not billed','Billed','Paid') then raise exception 'Completed repairs cannot be reassigned'; end if;
    if new.assigned_to is null then new.status := 'New';
    else
      if not exists(select 1 from public.staff where user_id=new.assigned_to and active and role='technician') then raise exception 'Select an active technician'; end if;
      new.status := 'Assigned';
    end if;
  elsif new.status is distinct from old.status then
    if new.status in ('Paid, not billed','Billed','Paid') then
      if current_user not in ('postgres','service_role','supabase_admin') then raise exception 'Billing status follows invoices and payments automatically'; end if;
      if old.status not in ('Repair Complete','Paid, not billed','Billed','Paid') then raise exception 'Complete the repair before collecting payment or billing'; end if;
      if new.status is distinct from jyoti_private.ticket_financial_status(new.id) then raise exception 'Ticket status must match its invoice and payments'; end if;
      return new;
    end if;
    if new.assigned_to is null or not (
      (old.status='Assigned' and new.status in ('In Progress','Awaiting Parts','Repair Complete'))
      or (old.status='In Progress' and new.status in ('Awaiting Parts','Repair Complete'))
      or (old.status='Awaiting Parts' and new.status in ('In Progress','Repair Complete'))
    ) then raise exception 'Invalid repair status change'; end if;
  end if;
  return new;
end
$$;

create or replace function jyoti_private.sync_ticket_billing_status() returns trigger
language plpgsql set search_path='' as $$
declare ticket_ids uuid[]; ticket uuid; desired text;
begin
  if tg_table_name='invoices' then ticket_ids:=array[new.ticket_id];
  elsif tg_op='DELETE' then ticket_ids:=array[old.ticket_id];
  elsif tg_op='UPDATE' then ticket_ids:=array[old.ticket_id,new.ticket_id];
  else ticket_ids:=array[new.ticket_id]; end if;
  for ticket in select distinct value from unnest(ticket_ids) value where value is not null order by value loop
    perform 1 from public.service_tickets where id=ticket for update;
    desired:=jyoti_private.ticket_financial_status(ticket);
    update public.service_tickets set status=desired where id=ticket and status is distinct from desired;
  end loop;
  return null;
end
$$;

create function jyoti_private.normalize_ticket_payment() returns trigger
language plpgsql set search_path='' as $$
declare invoice_ticket uuid;
begin
  if tg_op='UPDATE' and old.signature_media_id is not null and
    row(new.amount,new.method,new.ticket_id,new.collected_by,new.acknowledgement,new.signature_waiver,new.signature_media_id)
    is distinct from row(old.amount,old.method,old.ticket_id,old.collected_by,old.acknowledgement,old.signature_waiver,old.signature_media_id) then
    raise exception 'A signed cash receipt cannot be changed';
  end if;
  if new.invoice_id is not null then
    select ticket_id into strict invoice_ticket from public.invoices where id=new.invoice_id;
    if new.ticket_id is not null and new.ticket_id<>invoice_ticket then raise exception 'Invoice belongs to a different ticket'; end if;
    new.ticket_id:=invoice_ticket;
  end if;
  return new;
end
$$;
revoke all on function jyoti_private.normalize_ticket_payment() from public,anon,authenticated;
create trigger normalize_ticket_payment before insert or update on public.payments
for each row execute function jyoti_private.normalize_ticket_payment();

create function jyoti_private.link_ticket_collections() returns trigger
language plpgsql set search_path='' as $$
begin
  update public.payments set invoice_id=new.id where ticket_id=new.ticket_id and invoice_id is null and supplier_bill_id is null;
  return null;
end
$$;
revoke all on function jyoti_private.link_ticket_collections() from public,anon,authenticated;
create trigger attach_ticket_collections after insert on public.invoices
for each row execute function jyoti_private.link_ticket_collections();

create or replace function jyoti_private.check_parts_review() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.status='Repair Complete' and old.status is distinct from new.status then
    if not new.parts_reviewed or not exists(select 1 from public.ticket_parts where ticket_id=new.id) then
      raise exception 'Add at least one item in Parts used before completing the repair';
    end if;
    if length(trim(new.completion_notes))=0 or length(trim(new.test_result))=0 then
      raise exception 'Add the work performed and test result before completing the repair';
    end if;
  end if;
  return new;
end
$$;

create function public.save_ticket_inspection(p_ticket uuid,p_user uuid,p_notes text) returns void
language plpgsql set search_path='' as $$
declare ticket public.service_tickets%rowtype;
begin
  select * into strict ticket from public.service_tickets where id=p_ticket for update;
  if ticket.assigned_to is distinct from p_user or not exists(select 1 from public.staff where user_id=p_user and active and role='technician') then raise exception 'Only the assigned technician can save the inspection'; end if;
  if ticket.status not in ('Assigned','In Progress','Awaiting Parts') then raise exception 'Inspection can be edited before repair completion'; end if;
  update public.service_tickets set inspection_notes=p_notes,inspected_at=coalesce(inspected_at,now()),
    status=case when status='Assigned' then 'In Progress' else status end where id=p_ticket;
end
$$;

create function public.complete_service_ticket(p_ticket uuid,p_user uuid,p_parts jsonb,p_notes text,p_test text) returns jsonb
language plpgsql set search_path='' as $$
declare ticket public.service_tickets%rowtype; saved_parts jsonb; requested_parts jsonb;
begin
  select * into strict ticket from public.service_tickets where id=p_ticket for update;
  if ticket.assigned_to is distinct from p_user or not exists(select 1 from public.staff where user_id=p_user and active and role='technician') then raise exception 'Only the assigned technician can complete the repair'; end if;
  if length(trim(coalesce(p_notes,'')))=0 or length(trim(coalesce(p_test,'')))=0 then raise exception 'Add the work performed and test result'; end if;
  if jsonb_typeof(p_parts) is distinct from 'array' or jsonb_array_length(p_parts)=0 then raise exception 'Add at least one part used'; end if;
  if ticket.status in ('Repair Complete','Paid, not billed','Billed','Paid') then
    select jsonb_agg(jsonb_build_object('item_id',item_id,'quantity',quantity) order by item_id) into saved_parts from public.ticket_parts where ticket_id=p_ticket;
    select jsonb_agg(jsonb_build_object('item_id',item_id,'quantity',quantity) order by item_id) into requested_parts from jsonb_to_recordset(p_parts) as part(item_id uuid,quantity numeric);
    if ticket.completion_notes is distinct from p_notes or ticket.test_result is distinct from p_test or saved_parts is distinct from requested_parts then raise exception 'The repair has already been completed'; end if;
    return jsonb_build_object('status',ticket.status);
  end if;
  perform public.save_ticket_parts(p_ticket,p_user,p_parts);
  update public.service_tickets set completion_notes=p_notes,test_result=p_test,completed_at=now(),status='Repair Complete' where id=p_ticket;
  return jsonb_build_object('status','Repair Complete');
end
$$;

create function public.receive_ticket_payment(p_id uuid,p_ticket uuid,p_user uuid,p_amount numeric,p_method text,p_reference text,p_proof uuid,p_signature uuid,p_waiver text)
returns public.payments language plpgsql set search_path='' as $$
declare ticket public.service_tickets%rowtype; bill public.invoices%rowtype; payment public.payments%rowtype; paid numeric; actor_role text; media public.ticket_media%rowtype; media_id uuid;
begin
  select * into strict ticket from public.service_tickets where id=p_ticket for update;
  select role into actor_role from public.staff where user_id=p_user and active;
  if actor_role is null or (actor_role='technician' and ticket.assigned_to is distinct from p_user) then raise exception 'Only the assigned technician or billing team can collect payment'; end if;
  if ticket.status not in ('Repair Complete','Paid, not billed','Billed','Paid') then raise exception 'Complete the repair before collecting payment'; end if;
  select * into payment from public.payments where id=p_id;
  if found then
    if payment.ticket_id is distinct from p_ticket or payment.amount<>p_amount or payment.method<>p_method or payment.reference is distinct from p_reference
      or payment.collected_by is distinct from p_user or payment.proof_media_id is distinct from p_proof or payment.signature_media_id is distinct from p_signature or payment.signature_waiver is distinct from p_waiver then raise exception 'Payment request ID already used'; end if;
    return payment;
  end if;
  if p_amount is null or p_amount<=0 or p_amount>9999999 or p_amount<>round(p_amount,2) or p_method not in ('Cash','UPI') then raise exception 'Enter a valid amount and choose Cash or UPI'; end if;
  if p_method='Cash' and p_signature is null and length(trim(coalesce(p_waiver,'')))=0 then raise exception 'Capture the customer signature or record why they cannot sign'; end if;
  if p_method='UPI' and (p_signature is not null or length(coalesce(p_waiver,''))>0) then raise exception 'Customer signature applies to cash payments'; end if;
  if p_method='Cash' and p_proof is not null then raise exception 'Use a signature for cash acknowledgement'; end if;
  for media_id in select unnest(array[p_proof,p_signature]) loop
    if media_id is null then continue; end if;
    select * into strict media from public.ticket_media where id=media_id for update;
    if media.ticket_id<>p_ticket or media.uploaded_by<>p_user or not media.ready or media.payment_id is not null or
      media.stage<>(case when media_id=p_signature then 'signature' else 'payment' end) then raise exception 'Payment proof is unavailable or belongs to another ticket'; end if;
  end loop;
  select * into bill from public.invoices where ticket_id=p_ticket for update;
  if found then
    select coalesce(sum(amount),0) into paid from public.payments where ticket_id=p_ticket;
    if paid+p_amount>bill.total then raise exception 'Amount exceeds the outstanding balance'; end if;
  end if;
  insert into public.payments(id,ticket_id,invoice_id,amount,method,reference,collected_by,proof_media_id,signature_media_id,signature_waiver,acknowledgement)
  values(p_id,p_ticket,bill.id,p_amount,p_method,p_reference,p_user,p_proof,p_signature,p_waiver,
    case when p_method='Cash' then 'I confirm that I paid ₹'||p_amount::numeric(12,2)::text||' in cash to Jyoti Refrigeration for ticket #'||ticket.ticket_number||'.' else '' end)
  returning * into payment;
  update public.ticket_media set payment_id=p_id where id in (p_proof,p_signature);
  return payment;
end
$$;

revoke all on function public.save_ticket_inspection(uuid,uuid,text), public.complete_service_ticket(uuid,uuid,jsonb,text,text),
  public.receive_ticket_payment(uuid,uuid,uuid,numeric,text,text,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.save_ticket_inspection(uuid,uuid,text), public.complete_service_ticket(uuid,uuid,jsonb,text,text),
  public.receive_ticket_payment(uuid,uuid,uuid,numeric,text,text,uuid,uuid,text) to service_role;

create or replace function public.save_ticket_parts(p_ticket uuid, p_user uuid, p_parts jsonb)
returns void language plpgsql set search_path = '' as $$
declare ticket public.service_tickets%rowtype;
begin
  select * into strict ticket from public.service_tickets where id = p_ticket for update;
  if ticket.assigned_to is distinct from p_user or ticket.status in ('Repair Complete','Paid, not billed','Billed','Paid') or not exists (
    select 1 from public.staff where user_id = p_user and active and role = 'technician'
  ) then
    raise exception 'Only the assigned technician can record parts before completion';
  end if;

  delete from public.ticket_parts where ticket_id = p_ticket;
  insert into public.ticket_parts(ticket_id,item_id,quantity)
  select p_ticket, item_id, quantity from jsonb_to_recordset(p_parts) as part(item_id uuid,quantity numeric);

  if exists (
    select 1 from public.ticket_parts p join public.items i on i.id = p.item_id
    where p.ticket_id = p_ticket and not i.active
  ) then
    raise exception 'Select active items';
  end if;
  update public.service_tickets set parts_reviewed = true where id = p_ticket;
end
$$;
create or replace function public.issue_discounted_service_invoice(
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
  if ticket.status not in ('Repair Complete','Paid, not billed') then raise exception 'Finish the repair before issuing an invoice'; end if;
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


create or replace function public.issue_service_invoice(
  p_ticket uuid, p_fee numeric, p_tax_rate numeric, p_gstin text, p_issuer jsonb, p_start bigint
) returns public.invoices language plpgsql set search_path = '' as $$
declare
  ticket public.service_tickets%rowtype;
  bill public.invoices%rowtype;
  issued date := (statement_timestamp() at time zone 'Asia/Kolkata')::date;
  start_year integer; fy text; n bigint;
  rows jsonb; net numeric; cgst_amount numeric; sgst_amount numeric;
begin
  select * into strict ticket from public.service_tickets where id = p_ticket for update;
  select * into bill from public.invoices where ticket_id = p_ticket;
  if found then return bill; end if;
  if ticket.status not in ('Repair Complete','Paid, not billed') then raise exception 'Finish the repair before issuing an invoice'; end if;
  if p_issuer ->> 'name' is distinct from 'JYOTI REFRIGERATION.' then raise exception 'Invoice issuer has not been configured'; end if;

  if exists(select 1 from public.ticket_parts p join public.items i on i.id=p.item_id where p.ticket_id=p_ticket and i.sale_price is null) then raise exception 'Enter the customer prices in the invoice draft'; end if;
  with itemized as (
    select i.description, i.hsn_sac, i.uom, p.quantity, i.sale_price unit_price,
      i.tax_rate, round(p.quantity * i.sale_price,2) amount
    from public.ticket_parts p join public.items i on i.id = p.item_id where p.ticket_id = p_ticket
    union all
    select 'SERVICE CHARGES','9987','Pcs.',1,p_fee,p_tax_rate,round(p_fee,2)
  ),
  taxed as (
    select *, round(amount * tax_rate / 200,2) cgst, round(amount * tax_rate / 200,2) sgst from itemized
  )
  select jsonb_agg(to_jsonb(taxed) order by (hsn_sac = '9987'), description),
    sum(amount),sum(cgst),sum(sgst) into rows,net,cgst_amount,sgst_amount from taxed;
  if net <= 0 then raise exception 'Invoice total must be positive'; end if;

  start_year := extract(year from issued)::integer - case when extract(month from issued) < 4 then 1 else 0 end;
  fy := start_year::text || '-' || right((start_year + 1)::text,2);
  insert into public.invoice_counters as counters(financial_year,last_number) values(fy,greatest(1,p_start))
  on conflict(financial_year) do update set last_number = counters.last_number + 1 returning last_number into n;

  insert into public.invoices(ticket_id,number,issued_on,customer_name,service_address,customer_gstin,issuer,lines,subtotal,cgst,sgst,total)
    values(p_ticket,n::text || '/' || fy,issued,ticket.customer_name,
      concat_ws(', ', ticket.service_address,ticket.locality,ticket.city),p_gstin,p_issuer,rows,net,cgst_amount,sgst_amount,net+cgst_amount+sgst_amount)
    returning * into bill;
  return bill;
end
$$;


create or replace function public.record_payment(p_id uuid,p_invoice uuid,p_bill uuid,p_amount numeric,p_method text,p_reference text)
returns public.payments language plpgsql set search_path = '' as $$
declare payment public.payments%rowtype; due numeric; paid numeric; ticket uuid;
begin
  if (p_invoice is null) = (p_bill is null) then raise exception 'Select exactly one invoice or supplier bill'; end if;
  if p_invoice is not null then
    select ticket_id into strict ticket from public.invoices where id=p_invoice;
    perform 1 from public.service_tickets where id=ticket for update;
    select total into strict due from public.invoices where id = p_invoice for update;
  else
    select amount into strict due from public.supplier_bills where id = p_bill for update;
  end if;
  select * into payment from public.payments where id = p_id;
  if found then
    if payment.invoice_id is distinct from p_invoice or payment.supplier_bill_id is distinct from p_bill
      or payment.amount <> p_amount or payment.method <> p_method or payment.reference <> p_reference
      then raise exception 'Payment request ID already used'; end if;
    return payment;
  end if;
  select coalesce(sum(amount),0) into paid from public.payments where invoice_id = p_invoice or supplier_bill_id = p_bill;
  if p_amount <= 0 or paid + p_amount > due then raise exception 'Amount exceeds the outstanding balance'; end if;
  insert into public.payments(id,invoice_id,supplier_bill_id,amount,method,reference)
    values(p_id,p_invoice,p_bill,p_amount,p_method,p_reference) returning * into payment;
  return payment;
end
$$;


grant usage,select on sequence public.payments_receipt_number_seq to service_role;
