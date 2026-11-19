alter table public.service_tickets
 add column assignment_version integer not null default 1,
 add column assignment_responded_at timestamptz,
 add column rejection_reason text not null default '' check(length(rejection_reason)<=500),
 add column activity_version bigint not null default 0,
 add column updated_at timestamptz not null default now();
alter table public.service_tickets drop constraint service_tickets_status_check;
alter table public.service_tickets add constraint service_tickets_status_check check(
 status in ('New','Assigned','Accepted','Assignment Rejected','In Progress','Inspection Complete','Awaiting Parts','Repair Complete','Paid, not billed','Billed','Paid')
);
update public.service_tickets set assignment_responded_at=coalesce(inspected_at,completed_at,created_at)
where assigned_to is not null and status not in ('New','Assigned');

create or replace function jyoti_private.validate_ticket_update() returns trigger
language plpgsql set search_path='' as $$
begin
 if new.assigned_to is distinct from old.assigned_to then
  if (select jyoti_private.staff_role()) is distinct from 'manager' then raise exception 'Only managers can assign tickets';end if;
  if old.status in ('Repair Complete','Paid, not billed','Billed','Paid') then raise exception 'Completed repairs cannot be reassigned';end if;
  new.inspection_completed_at:=null;new.inspected_at:=null;
  new.assignment_version:=old.assignment_version+1;new.assignment_responded_at:=null;new.rejection_reason:='';
  if new.assigned_to is null then new.status:='New';
  else
   if not exists(select 1 from public.staff where user_id=new.assigned_to and active and role='technician')then raise exception 'Select an active technician';end if;
   new.status:='Assigned';
  end if;
 elsif new.status is distinct from old.status then
  if new.status in ('Paid, not billed','Billed','Paid') then
   if current_user not in ('postgres','service_role','supabase_admin')then raise exception 'Billing status follows invoices and payments automatically';end if;
   if old.status not in ('Repair Complete','Paid, not billed','Billed','Paid')then raise exception 'Complete the repair before collecting payment or billing';end if;
   if new.status is distinct from jyoti_private.ticket_financial_status(new.id)then raise exception 'Ticket status must match its invoice and payments';end if;
   return new;
  end if;
  if new.assigned_to is null or not (
   (old.status='Assigned' and new.status in ('Accepted','Assignment Rejected') and new.assignment_responded_at is not null)
   or (old.status='Accepted' and new.status='In Progress')
   or (old.status='In Progress' and new.status='Inspection Complete' and new.inspection_completed_at is not null)
   or (old.status='Inspection Complete' and new.status in ('Awaiting Parts','Repair Complete'))
   or (old.status='Awaiting Parts' and new.status='Repair Complete')
  )then raise exception 'Accept the assignment and finish the current stage before changing progress';end if;
 end if;
 return new;
end $$;

create function public.respond_ticket_assignment(p_ticket uuid,p_user uuid,p_version integer,p_response text,p_reason text)
returns jsonb language plpgsql set search_path='' as $$
declare ticket public.service_tickets%rowtype; desired text;
begin
 select * into strict ticket from public.service_tickets where id=p_ticket for update;
 if ticket.assigned_to is distinct from p_user or not exists(select 1 from public.staff where user_id=p_user and active and role='technician')then raise exception 'Only the assigned technician can respond to this assignment';end if;
 if p_version is distinct from ticket.assignment_version then raise exception 'This assignment has changed. Open the latest ticket before responding';end if;
 if p_response not in ('accept','reject') or p_response is null then raise exception 'Choose Accept or Reject';end if;
 desired:=case when p_response='accept' then 'Accepted' else 'Assignment Rejected' end;
 if ticket.status=desired then return jsonb_build_object('status',ticket.status);end if;
 if ticket.status<>'Assigned' then
  if p_response='accept' and ticket.assignment_responded_at is not null and ticket.status not in ('New','Assignment Rejected')then return jsonb_build_object('status',ticket.status);end if;
  raise exception 'This assignment has already been answered';
 end if;
 update public.service_tickets set status=desired,assignment_responded_at=now(),rejection_reason=case when p_response='reject' then coalesce(p_reason,'') else '' end where id=p_ticket;
 return jsonb_build_object('status',desired);
end $$;
revoke all on function public.respond_ticket_assignment(uuid,uuid,integer,text,text) from public,anon,authenticated;
grant execute on function public.respond_ticket_assignment(uuid,uuid,integer,text,text) to service_role;

create or replace function public.advance_ticket_inspection(p_ticket uuid,p_user uuid,p_action text,p_notes text) returns void
language plpgsql set search_path='' as $$
declare ticket public.service_tickets%rowtype;
begin
 select * into strict ticket from public.service_tickets where id=p_ticket for update;
 if ticket.assigned_to is distinct from p_user or not exists(select 1 from public.staff where user_id=p_user and active and role='technician')then raise exception 'Only the assigned technician can save the inspection';end if;
 if p_action='start' then
  if ticket.status='In Progress' then return;end if;
  if ticket.status<>'Accepted' then raise exception 'Accept the assignment before starting inspection';end if;
  update public.service_tickets set status='In Progress',inspected_at=now(),inspection_completed_at=null where id=p_ticket;
 elsif p_action in ('save','complete') then
  if p_action='complete' and ticket.inspection_completed_at is not null and ticket.inspection_notes is not distinct from p_notes then return;end if;
  if ticket.status<>'In Progress' then raise exception 'Start inspection before saving comments or completing it';end if;
  update public.service_tickets set inspection_notes=coalesce(p_notes,''),
   inspection_completed_at=case when p_action='complete' then now() else null end,
   status=case when p_action='complete' then 'Inspection Complete' else status end where id=p_ticket;
 else raise exception 'Choose a valid inspection action';end if;
end $$;

create function jyoti_private.touch_ticket_activity() returns trigger
language plpgsql set search_path='' as $$
begin
 new.activity_version:=old.activity_version+1;
 new.updated_at:=clock_timestamp();
 return new;
end $$;
revoke all on function jyoti_private.touch_ticket_activity() from public,anon,authenticated;
create trigger aa_touch_ticket_activity before update on public.service_tickets for each row execute function jyoti_private.touch_ticket_activity();

create function jyoti_private.touch_related_ticket_activity() returns trigger
language plpgsql set search_path='' as $$
declare ids uuid[]; ticket uuid;
begin
 if tg_op='DELETE' then ids:=array[old.ticket_id];
 elsif tg_op='INSERT' then ids:=array[new.ticket_id];
 else ids:=array[old.ticket_id,new.ticket_id];end if;
 for ticket in select distinct value from unnest(ids) value where value is not null order by value loop
  update public.service_tickets set updated_at=clock_timestamp() where id=ticket;
 end loop;
 return null;
end $$;
revoke all on function jyoti_private.touch_related_ticket_activity() from public,anon,authenticated;
create trigger touch_ticket_activity after insert or update or delete on public.ticket_parts for each row execute function jyoti_private.touch_related_ticket_activity();
create trigger touch_ticket_activity after insert or update or delete on public.ticket_media for each row execute function jyoti_private.touch_related_ticket_activity();
create trigger touch_ticket_activity after insert or update or delete on public.payments for each row execute function jyoti_private.touch_related_ticket_activity();
create trigger touch_ticket_activity after insert or update or delete on public.invoices for each row execute function jyoti_private.touch_related_ticket_activity();

do $$begin
 if exists(select 1 from pg_publication where pubname='supabase_realtime') and not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='service_tickets')then
  alter publication supabase_realtime add table public.service_tickets;
 end if;
end $$;
