create table public.staff (
  user_id uuid primary key references auth.users(id),
  name text not null check (length(trim(name)) between 1 and 100),
  role text not null check (role in ('manager', 'technician', 'billing')),
  active boolean not null default true
);

create table public.service_tickets (
  id uuid primary key default gen_random_uuid(),
  ticket_number integer generated always as identity (start with 10001 maxvalue 99999) unique,
  customer_id uuid references auth.users(id),
  created_by uuid not null default auth.uid() references auth.users(id),
  customer_name text not null check (length(trim(customer_name)) between 1 and 100),
  mobile text not null check (mobile ~ '^[6-9][0-9]{9}$'),
  locality text not null check (length(trim(locality)) between 1 and 100),
  city text not null default 'Ambikapur, CG',
  service_address text not null check (length(trim(service_address)) between 1 and 500),
  appliance text not null check (length(trim(appliance)) between 1 and 100),
  brand text not null check (length(trim(brand)) between 1 and 100),
  service_type text not null check (service_type in ('Bring to Shop', 'Home Visit', 'Home Pickup', 'Installation')),
  issue text not null check (length(trim(issue)) between 1 and 2000),
  latitude numeric check (latitude between -90 and 90),
  longitude numeric check (longitude between -180 and 180),
  assigned_to uuid references public.staff(user_id),
  status text not null default 'New' check (status in ('New','Assigned','In Progress','Awaiting Parts','Repair Complete')),
  created_at timestamptz not null default now(),
  check ((latitude is null) = (longitude is null)),
  check (service_type <> 'Home Visit' or latitude is not null)
);

create index service_tickets_customer_idx on public.service_tickets (customer_id, created_at desc);
create index service_tickets_assignee_idx on public.service_tickets (assigned_to, created_at desc);
create index service_tickets_status_idx on public.service_tickets (status, created_at desc);

alter table public.staff enable row level security;
alter table public.service_tickets enable row level security;

create schema if not exists jyoti_private;
revoke all on schema jyoti_private from public;
grant usage on schema jyoti_private to authenticated;

create function jyoti_private.staff_role() returns text
language sql stable security definer set search_path = ''
as $$ select role from public.staff where user_id = (select auth.uid()) and active $$;

revoke all on function jyoti_private.staff_role() from public, anon, authenticated;
grant execute on function jyoti_private.staff_role() to authenticated;

revoke all on public.staff, public.service_tickets from anon, authenticated;
grant select on public.staff, public.service_tickets to authenticated;
grant insert (customer_id, customer_name, mobile, locality, city, service_address, appliance, brand,
  service_type, issue, latitude, longitude) on public.service_tickets to authenticated;
grant update (assigned_to, status) on public.service_tickets to authenticated;

create policy staff_read on public.staff for select to authenticated
using (user_id = (select auth.uid()) or (select jyoti_private.staff_role()) = 'manager');

create policy tickets_read on public.service_tickets for select to authenticated
using (
  customer_id = (select auth.uid())
  or (select jyoti_private.staff_role()) in ('manager', 'billing')
  or ((select jyoti_private.staff_role()) = 'technician' and assigned_to = (select auth.uid()))
);

create policy tickets_create on public.service_tickets for insert to authenticated
with check (
  created_by = (select auth.uid()) and (
    ((select jyoti_private.staff_role()) = 'manager' and customer_id is null)
    or (customer_id = (select auth.uid()) and '91' || mobile = (select auth.jwt() ->> 'phone'))
  )
);

create policy tickets_update on public.service_tickets for update to authenticated
using (
  (select jyoti_private.staff_role()) = 'manager'
  or ((select jyoti_private.staff_role()) = 'technician' and assigned_to = (select auth.uid()))
)
with check (
  (select jyoti_private.staff_role()) = 'manager'
  or ((select jyoti_private.staff_role()) = 'technician' and assigned_to = (select auth.uid()))
);

create function jyoti_private.validate_ticket_update() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if new.assigned_to is distinct from old.assigned_to then
    if (select jyoti_private.staff_role()) is distinct from 'manager' then
      raise exception 'Only managers can assign tickets';
    end if;
    if old.status = 'Repair Complete' then
      raise exception 'Completed repairs cannot be reassigned';
    end if;
    if new.assigned_to is null then
      new.status := 'New';
    else
      if not exists (select 1 from public.staff where user_id = new.assigned_to and active and role = 'technician') then
        raise exception 'Select an active technician';
      end if;
      new.status := 'Assigned';
    end if;
  elsif new.status is distinct from old.status then
    if new.assigned_to is null or not (
      (old.status = 'Assigned' and new.status in ('In Progress', 'Awaiting Parts', 'Repair Complete'))
      or (old.status = 'In Progress' and new.status in ('Awaiting Parts', 'Repair Complete'))
      or (old.status = 'Awaiting Parts' and new.status in ('In Progress', 'Repair Complete'))
    ) then
      raise exception 'Invalid repair status change';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function jyoti_private.validate_ticket_update() from public, anon, authenticated;
create trigger validate_ticket_update before update on public.service_tickets
for each row execute function jyoti_private.validate_ticket_update();
