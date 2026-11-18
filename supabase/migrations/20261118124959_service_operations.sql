alter table public.service_tickets alter column created_by drop not null;
alter table public.service_tickets
  add column intake_source text not null default 'Website' check (intake_source in ('Website','Walk-in','Phone')),
  add column parts_reviewed boolean not null default false,
  add column maps_url text,
  add column intake_key uuid unique;

alter table public.service_tickets drop constraint service_tickets_service_type_check;
alter table public.service_tickets add constraint service_tickets_service_type_check check (
  service_type in ('Bring to Shop','Home Visit','Home Pickup','Installation','Preventive Maintenance','Warranty Service')
);
alter table public.service_tickets drop constraint service_tickets_check1;

create table public.items (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  description text not null,
  uom text not null,
  hsn_sac text not null default '',
  purchase_price numeric(12,2) not null check (purchase_price >= 0),
  sale_price numeric(12,2) not null check (sale_price >= 0),
  tax_rate numeric(5,2) not null check (tax_rate between 0 and 100),
  active boolean not null default true
);

create table public.ticket_parts (
  ticket_id uuid not null references public.service_tickets(id),
  item_id uuid not null references public.items(id),
  quantity numeric(10,3) not null check (quantity > 0),
  primary key (ticket_id, item_id)
);

create table public.suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  contact text not null default '',
  address text not null default '',
  gstin text not null default ''
);

create table public.purchase_orders (
  id uuid primary key default gen_random_uuid(),
  po_number bigint generated always as identity (start with 1001) unique,
  supplier_id uuid not null references public.suppliers(id),
  ticket_id uuid references public.service_tickets(id),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create table public.purchase_lines (
  id uuid primary key default gen_random_uuid(),
  po_id uuid not null references public.purchase_orders(id),
  item_id uuid not null references public.items(id),
  description text not null,
  uom text not null,
  quantity numeric(10,3) not null check (quantity > 0),
  received numeric(10,3) not null default 0 check (received between 0 and quantity),
  unit_price numeric(12,2) not null check (unit_price >= 0),
  unique (po_id, item_id)
);

create table public.purchase_receipts (
  id uuid primary key,
  line_id uuid not null references public.purchase_lines(id),
  quantity numeric(10,3) not null check (quantity > 0),
  received_at timestamptz not null default now()
);

create table public.supplier_bills (
  id uuid primary key default gen_random_uuid(),
  po_id uuid not null references public.purchase_orders(id),
  bill_number text not null,
  bill_date date not null,
  amount numeric(12,2) not null check (amount > 0),
  unique (po_id, bill_number)
);

create table public.invoice_counters (
  financial_year text primary key,
  last_number bigint not null check (last_number > 0)
);

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null unique references public.service_tickets(id),
  number text not null unique,
  issued_on date not null,
  customer_name text not null,
  service_address text not null,
  customer_gstin text not null default '',
  issuer jsonb not null,
  lines jsonb not null,
  subtotal numeric(12,2) not null,
  cgst numeric(12,2) not null,
  sgst numeric(12,2) not null,
  total numeric(12,2) not null check (total > 0)
);

create table public.payments (
  id uuid primary key,
  supplier_bill_id uuid references public.supplier_bills(id),
  invoice_id uuid references public.invoices(id),
  amount numeric(12,2) not null check (amount > 0),
  method text not null check (method in ('Cash','UPI','Bank Transfer','Card','Other')),
  reference text not null default '',
  paid_at timestamptz not null default now(),
  check ((supplier_bill_id is null) <> (invoice_id is null))
);

create table public.push_subscriptions (
  endpoint text primary key check (endpoint like 'https://%'),
  user_id uuid not null references public.staff(user_id) on delete cascade,
  subscription jsonb not null
);

create table public.public_rate_limits (
  bucket text primary key,
  expires_at timestamptz not null,
  hits integer not null check (hits > 0)
);

create index purchase_orders_supplier_idx on public.purchase_orders(supplier_id);
create index supplier_bills_po_idx on public.supplier_bills(po_id);
create index payments_invoice_idx on public.payments(invoice_id);
create index payments_supplier_idx on public.payments(supplier_bill_id);
create index push_subscriptions_user_idx on public.push_subscriptions(user_id);
create index service_tickets_recency_idx on public.service_tickets(created_at desc);

do $$
declare rel text;
begin
  foreach rel in array array['items','ticket_parts','suppliers','purchase_orders','purchase_lines',
    'purchase_receipts','supplier_bills','invoice_counters','invoices','payments','push_subscriptions','public_rate_limits']
  loop
    execute format('alter table public.%I enable row level security', rel);
    execute format('revoke all on table public.%I from public, anon, authenticated', rel);
    execute format('grant select, insert, update, delete on table public.%I to service_role', rel);
  end loop;
end
$$;

grant select, insert, update on public.staff, public.service_tickets to service_role;

insert into public.suppliers(name) values ('Jyoti Refrigeration');

create function jyoti_private.check_parts_review() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.status = 'Repair Complete' and not new.parts_reviewed then
    raise exception 'Record the parts used or confirm no parts were used before completing the repair';
  end if;
  return new;
end
$$;
revoke all on function jyoti_private.check_parts_review() from public, anon, authenticated;
create trigger zz_check_parts_review before update on public.service_tickets
for each row execute function jyoti_private.check_parts_review();

create function public.save_ticket_parts(p_ticket uuid, p_user uuid, p_parts jsonb)
returns void language plpgsql set search_path = '' as $$
declare ticket public.service_tickets%rowtype;
begin
  select * into strict ticket from public.service_tickets where id = p_ticket for update;
  if ticket.assigned_to is distinct from p_user or ticket.status = 'Repair Complete' or not exists (
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

create function public.create_purchase_order(p_supplier uuid, p_ticket uuid, p_user uuid, p_lines jsonb)
returns public.purchase_orders language plpgsql set search_path = '' as $$
declare po public.purchase_orders%rowtype; line_count integer;
begin
  insert into public.purchase_orders(supplier_id,ticket_id,created_by) values (p_supplier,p_ticket,p_user) returning * into po;
  insert into public.purchase_lines(po_id,item_id,description,uom,quantity,unit_price)
  select po.id, i.id, i.description, i.uom, l.quantity, l.unit_price
  from jsonb_to_recordset(p_lines) as l(item_id uuid,quantity numeric,unit_price numeric)
  join public.items i on i.id = l.item_id and i.active;
  get diagnostics line_count = row_count;
  if line_count = 0 or line_count <> jsonb_array_length(p_lines) then
    raise exception 'Each purchase line must reference an active item';
  end if;
  return po;
end
$$;

create function public.record_receipt(p_id uuid,p_line uuid,p_quantity numeric)
returns numeric language plpgsql set search_path = '' as $$
declare line public.purchase_lines%rowtype; receipt public.purchase_receipts%rowtype;
begin
  select * into strict line from public.purchase_lines where id = p_line for update;
  select * into receipt from public.purchase_receipts where id = p_id;
  if found then
    if receipt.line_id <> p_line or receipt.quantity <> p_quantity then raise exception 'Receipt request ID already used'; end if;
    return line.received;
  end if;
  if p_quantity <= 0 or line.received + p_quantity > line.quantity then raise exception 'Quantity exceeds the open order quantity'; end if;
  insert into public.purchase_receipts(id,line_id,quantity) values(p_id,p_line,p_quantity);
  update public.purchase_lines set received = received + p_quantity where id = p_line returning received into line.received;
  return line.received;
end
$$;

create function public.issue_service_invoice(
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
  if ticket.status <> 'Repair Complete' then raise exception 'Finish the repair before issuing an invoice'; end if;
  if p_issuer ->> 'name' is distinct from 'JYOTI REFRIGERATION.' then raise exception 'Invoice issuer has not been configured'; end if;

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

create function public.record_payment(p_id uuid,p_invoice uuid,p_bill uuid,p_amount numeric,p_method text,p_reference text)
returns public.payments language plpgsql set search_path = '' as $$
declare payment public.payments%rowtype; due numeric; paid numeric;
begin
  if (p_invoice is null) = (p_bill is null) then raise exception 'Select exactly one invoice or supplier bill'; end if;
  if p_invoice is not null then
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

create function public.consume_rate_limit(p_bucket text,p_limit integer,p_window_seconds integer)
returns boolean language plpgsql set search_path = '' as $$
declare n integer;
begin
  delete from public.public_rate_limits where expires_at <= now();
  insert into public.public_rate_limits as limits(bucket,expires_at,hits)
    values(p_bucket,now()+make_interval(secs=>p_window_seconds),1)
  on conflict(bucket) do update set
    hits = case when limits.expires_at <= now() then 1 else least(limits.hits+1,p_limit+1) end,
    expires_at = case when limits.expires_at <= now() then excluded.expires_at else limits.expires_at end
  returning hits into n;
  return n <= p_limit;
end
$$;

revoke all on function public.save_ticket_parts(uuid,uuid,jsonb),
  public.create_purchase_order(uuid,uuid,uuid,jsonb), public.record_receipt(uuid,uuid,numeric),
  public.issue_service_invoice(uuid,numeric,numeric,text,jsonb,bigint),
  public.record_payment(uuid,uuid,uuid,numeric,text,text), public.consume_rate_limit(text,integer,integer)
from public, anon, authenticated;
grant execute on function public.save_ticket_parts(uuid,uuid,jsonb),
  public.create_purchase_order(uuid,uuid,uuid,jsonb), public.record_receipt(uuid,uuid,numeric),
  public.issue_service_invoice(uuid,numeric,numeric,text,jsonb,bigint),
  public.record_payment(uuid,uuid,uuid,numeric,text,text), public.consume_rate_limit(text,integer,integer)
to service_role;
