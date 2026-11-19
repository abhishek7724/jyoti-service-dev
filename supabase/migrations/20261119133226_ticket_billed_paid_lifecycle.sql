alter table public.service_tickets drop constraint service_tickets_status_check;
alter table public.service_tickets add constraint service_tickets_status_check check (
  status in ('New','Assigned','In Progress','Awaiting Parts','Repair Complete','Billed','Paid')
);

create or replace function jyoti_private.validate_ticket_update() returns trigger
language plpgsql set search_path = ''
as $$
declare billing_status text;
begin
  if new.assigned_to is distinct from old.assigned_to then
    if (select jyoti_private.staff_role()) is distinct from 'manager' then
      raise exception 'Only managers can assign tickets';
    end if;
    if old.status in ('Repair Complete','Billed','Paid') then
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
    if new.status in ('Billed','Paid') then
      if current_user not in ('postgres','service_role','supabase_admin') then
        raise exception 'Billing status follows invoices and payments automatically';
      end if;
      if old.status not in ('Repair Complete','Billed','Paid') then
        raise exception 'Complete the repair before billing';
      end if;
      select case when i.total <= coalesce(sum(p.amount),0) then 'Paid' else 'Billed' end
        into billing_status
        from public.invoices i left join public.payments p on p.invoice_id = i.id
        where i.ticket_id = new.id group by i.id;
      if new.status is distinct from billing_status then
        raise exception 'Ticket status must match its invoice and payments';
      end if;
      return new;
    end if;
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

create or replace function public.save_ticket_parts(p_ticket uuid, p_user uuid, p_parts jsonb)
returns void language plpgsql set search_path = '' as $$
declare ticket public.service_tickets%rowtype;
begin
  select * into strict ticket from public.service_tickets where id = p_ticket for update;
  if ticket.assigned_to is distinct from p_user or ticket.status in ('Repair Complete','Billed','Paid') or not exists (
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
create function jyoti_private.sync_ticket_billing_status() returns trigger
language plpgsql set search_path = '' as $$
declare invoice_ids uuid[];
begin
  if tg_table_name = 'invoices' then
    invoice_ids := array[new.id];
  elsif tg_op = 'DELETE' then
    invoice_ids := array[old.invoice_id];
  elsif tg_op = 'UPDATE' then
    invoice_ids := array[old.invoice_id,new.invoice_id];
  else
    invoice_ids := array[new.invoice_id];
  end if;

  update public.service_tickets t
    set status = billing.status
    from (
      select i.ticket_id,
        case when i.total <= coalesce(sum(p.amount),0) then 'Paid' else 'Billed' end status
      from public.invoices i left join public.payments p on p.invoice_id = i.id
      where i.id = any(invoice_ids)
      group by i.id
    ) billing
    where t.id = billing.ticket_id and t.status is distinct from billing.status;
  return null;
end
$$;
revoke all on function jyoti_private.sync_ticket_billing_status() from public,anon,authenticated;

create trigger ticket_invoice_status after insert or update of total on public.invoices
for each row execute function jyoti_private.sync_ticket_billing_status();
create trigger ticket_payment_status after insert or update or delete on public.payments
for each row execute function jyoti_private.sync_ticket_billing_status();

-- Bring previously issued invoices and recorded payments into the ticket lifecycle.
update public.service_tickets t
  set status = billing.status
  from (
    select i.ticket_id,
      case when i.total <= coalesce(sum(p.amount),0) then 'Paid' else 'Billed' end status
    from public.invoices i left join public.payments p on p.invoice_id = i.id
    group by i.id
  ) billing
  where t.id = billing.ticket_id and t.status is distinct from billing.status;
