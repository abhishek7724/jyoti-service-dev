alter table public.service_tickets add column inspection_completed_at timestamptz;
alter table public.service_tickets drop constraint service_tickets_status_check;
alter table public.service_tickets add constraint service_tickets_status_check check (
 status in ('New','Assigned','In Progress','Inspection Complete','Awaiting Parts','Repair Complete','Paid, not billed','Billed','Paid')
);
-- Preserve the inspection milestone for tickets already beyond that stage.
update public.service_tickets set inspection_completed_at=coalesce(inspected_at,completed_at,created_at)
where status in ('Awaiting Parts','Repair Complete','Paid, not billed','Billed','Paid');

create or replace function jyoti_private.validate_ticket_update() returns trigger
language plpgsql set search_path='' as $$
begin
 if new.assigned_to is distinct from old.assigned_to then
  if (select jyoti_private.staff_role()) is distinct from 'manager' then raise exception 'Only managers can assign tickets';end if;
  if old.status in ('Repair Complete','Paid, not billed','Billed','Paid') then raise exception 'Completed repairs cannot be reassigned';end if;
  new.inspection_completed_at:=null;
  new.inspected_at:=null;
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
   (old.status='Assigned' and new.status='In Progress')
   or (old.status='In Progress' and new.status='Inspection Complete' and new.inspection_completed_at is not null)
   or (old.status='Inspection Complete' and new.status in ('Awaiting Parts','Repair Complete'))
   or (old.status='Awaiting Parts' and new.status='Repair Complete')
  )then raise exception 'Finish the current inspection or repair stage before changing progress';end if;
 end if;
 return new;
end $$;

create function public.advance_ticket_inspection(p_ticket uuid,p_user uuid,p_action text,p_notes text) returns void
language plpgsql set search_path='' as $$
declare ticket public.service_tickets%rowtype;
begin
 select * into strict ticket from public.service_tickets where id=p_ticket for update;
 if ticket.assigned_to is distinct from p_user or not exists(select 1 from public.staff where user_id=p_user and active and role='technician')then raise exception 'Only the assigned technician can save the inspection';end if;
 if p_action='start' then
  if ticket.status='In Progress' then return;end if;
  if ticket.status<>'Assigned' then raise exception 'Inspection can start only on an assigned ticket';end if;
  update public.service_tickets set status='In Progress',inspected_at=now(),inspection_completed_at=null where id=p_ticket;
 elsif p_action in ('save','complete') then
  if p_action='complete' and ticket.inspection_completed_at is not null and ticket.inspection_notes is not distinct from p_notes then return;end if;
  if ticket.status<>'In Progress' then raise exception 'Start inspection before saving comments or completing it';end if;
  update public.service_tickets set inspection_notes=coalesce(p_notes,''),
   inspection_completed_at=case when p_action='complete' then now() else null end,
   status=case when p_action='complete' then 'Inspection Complete' else status end where id=p_ticket;
 else raise exception 'Choose a valid inspection action';end if;
end $$;
revoke all on function public.advance_ticket_inspection(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.advance_ticket_inspection(uuid,uuid,text,text) to service_role;

create or replace function public.save_ticket_inspection(p_ticket uuid,p_user uuid,p_notes text) returns void
language plpgsql set search_path='' as $$
begin
 perform public.advance_ticket_inspection(p_ticket,p_user,'save',p_notes);
end $$;

create or replace function jyoti_private.check_parts_review() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.status='Repair Complete' and old.status is distinct from new.status then
  if new.inspection_completed_at is null then raise exception 'Complete the inspection before completing the repair';end if;
  if not new.parts_reviewed or not exists(select 1 from public.ticket_parts where ticket_id=new.id)then raise exception 'Add at least one item in Parts used before completing the repair';end if;
  if length(trim(new.completion_notes))=0 then raise exception 'Add the work performed before completing the repair';end if;
 end if;
 return new;
end $$;

create or replace function public.complete_service_ticket(p_ticket uuid,p_user uuid,p_parts jsonb,p_notes text,p_test text) returns jsonb
language plpgsql set search_path='' as $$
declare ticket public.service_tickets%rowtype; saved_parts jsonb; requested_parts jsonb;
begin
  select * into strict ticket from public.service_tickets where id=p_ticket for update;
  if ticket.assigned_to is distinct from p_user or not exists(select 1 from public.staff where user_id=p_user and active and role='technician') then raise exception 'Only the assigned technician can complete the repair'; end if;
  if length(trim(coalesce(p_notes,'')))=0 then raise exception 'Add the work performed';end if;
  if jsonb_typeof(p_parts) is distinct from 'array' or jsonb_array_length(p_parts)=0 then raise exception 'Add at least one part used'; end if;
  if ticket.status in ('Repair Complete','Paid, not billed','Billed','Paid') then
    select jsonb_agg(jsonb_build_object('item_id',item_id,'quantity',quantity) order by item_id) into saved_parts from public.ticket_parts where ticket_id=p_ticket;
    select jsonb_agg(jsonb_build_object('item_id',item_id,'quantity',quantity) order by item_id) into requested_parts from jsonb_to_recordset(p_parts) as part(item_id uuid,quantity numeric);
    if ticket.completion_notes is distinct from p_notes or saved_parts is distinct from requested_parts then raise exception 'The repair has already been completed'; end if;
    return jsonb_build_object('status',ticket.status);
  end if;
  if ticket.status not in ('Inspection Complete','Awaiting Parts') or ticket.inspection_completed_at is null then raise exception 'Complete the inspection before completing the repair';end if;
  perform public.save_ticket_parts(p_ticket,p_user,p_parts);
  update public.service_tickets set completion_notes=p_notes,completed_at=now(),status='Repair Complete' where id=p_ticket;
  return jsonb_build_object('status','Repair Complete');
end
$$;

create or replace function public.receive_ticket_payment(p_id uuid,p_ticket uuid,p_user uuid,p_amount numeric,p_method text,p_reference text,p_proof uuid,p_signature uuid,p_waiver text)
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
  if p_method='UPI' and p_proof is null then raise exception 'Attach a payment photo or screenshot for UPI';end if;
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
