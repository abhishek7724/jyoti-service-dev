create table public.ticket_required_parts(
 ticket_id uuid not null references public.service_tickets(id),
 item_id uuid not null references public.items(id),
 quantity numeric(12,3) not null check(quantity>0 and quantity<=999999),
 requested_by uuid not null references public.staff(user_id),
 requested_at timestamptz not null default now(),
 primary key(ticket_id,item_id)
);
alter table public.ticket_required_parts enable row level security;
revoke all on public.ticket_required_parts from public,anon,authenticated;
grant select on public.ticket_required_parts to authenticated;
grant select,insert,update,delete on public.ticket_required_parts to service_role;
create policy required_parts_read on public.ticket_required_parts for select to authenticated
using(exists(select 1 from public.service_tickets t where t.id=ticket_id));
create trigger touch_ticket_activity after insert or update or delete on public.ticket_required_parts
 for each row execute function jyoti_private.touch_related_ticket_activity();

create function public.set_ticket_awaiting_parts(p_ticket uuid,p_user uuid,p_parts jsonb) returns void
language plpgsql set search_path='' as $$
declare ticket public.service_tickets%rowtype;
begin
 select * into strict ticket from public.service_tickets where id=p_ticket for update;
 if ticket.assigned_to is distinct from p_user or not exists(select 1 from public.staff where user_id=p_user and active and role='technician')then raise exception 'Only the assigned technician can record awaited parts';end if;
 if ticket.status not in ('Inspection Complete','Awaiting Parts')then raise exception 'Complete the inspection before requesting parts';end if;
 if jsonb_typeof(p_parts) is distinct from 'array' or jsonb_array_length(p_parts)<1 or jsonb_array_length(p_parts)>40 then raise exception 'Select at least one awaited part and quantity';end if;
 delete from public.ticket_required_parts where ticket_id=p_ticket;
 insert into public.ticket_required_parts(ticket_id,item_id,quantity,requested_by)
 select p_ticket,item_id,quantity,p_user from jsonb_to_recordset(p_parts) as row(item_id uuid,quantity numeric);
 if exists(select 1 from public.ticket_required_parts r join public.items i on i.id=r.item_id where r.ticket_id=p_ticket and not i.active)then raise exception 'Select active items';end if;
 update public.service_tickets set status='Awaiting Parts' where id=p_ticket;
end $$;
revoke all on function public.set_ticket_awaiting_parts(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.set_ticket_awaiting_parts(uuid,uuid,jsonb) to service_role;

create function jyoti_private.require_awaited_parts() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.status='Awaiting Parts' and old.status is distinct from new.status and not exists(select 1 from public.ticket_required_parts where ticket_id=new.id)then raise exception 'Select at least one awaited part and quantity';end if;
 return new;
end $$;
revoke all on function jyoti_private.require_awaited_parts() from public,anon,authenticated;
create trigger zz_require_awaited_parts before update on public.service_tickets for each row execute function jyoti_private.require_awaited_parts();

alter table public.push_subscriptions
 add column last_registered_at timestamptz not null default now(),
 add column last_accepted_at timestamptz,
 add column last_error_code integer;
