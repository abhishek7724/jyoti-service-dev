create or replace function jyoti_private.guard_ticket_intake_edit() returns trigger
language plpgsql set search_path='' as $$
begin
 if row(new.customer_name,new.mobile,new.locality,new.city,new.service_address,new.appliance,new.brand,new.service_type,new.issue,new.latitude,new.longitude,new.maps_url,new.intake_source)
 is distinct from row(old.customer_name,old.mobile,old.locality,old.city,old.service_address,old.appliance,old.brand,old.service_type,old.issue,old.latitude,old.longitude,old.maps_url,old.intake_source) then
  if old.status<>'New' or old.assigned_to is not null or old.assignment_version<>1
     or new.status<>'New' or new.assigned_to is not null or new.assignment_version<>1 then
   raise exception 'Only new, never-assigned tickets can be edited';
  end if;
  if current_user not in ('postgres','service_role','supabase_admin') and (select jyoti_private.staff_role()) is distinct from 'manager' then
   raise exception 'Only managers can edit ticket details';
  end if;
 end if;
 return new;
end $$;
revoke all on function jyoti_private.guard_ticket_intake_edit() from public,anon,authenticated;

create or replace function public.edit_new_service_ticket(p_ticket uuid,p_actor uuid,p_version bigint,p_details jsonb)
returns jsonb language plpgsql set search_path='' as $$
declare t public.service_tickets%rowtype; field text;
begin
 if not exists(select 1 from public.staff where user_id=p_actor and active and role='manager') then raise exception 'Only managers can edit ticket details';end if;
 select * into strict t from public.service_tickets where id=p_ticket for update;
 if t.status<>'New' or t.assigned_to is not null or t.assignment_version<>1 then raise exception 'This ticket has been assigned or work has started. Editing is locked';end if;
 if p_version is distinct from t.activity_version then raise exception 'This ticket has changed. Reload it before editing';end if;
 foreach field in array array['customer_name','mobile','locality','city','service_address','appliance','brand','service_type','issue'] loop
  if jsonb_typeof(p_details->field) is distinct from 'string' or length(trim(p_details->>field))=0 then raise exception 'Enter all required ticket fields';end if;
 end loop;
 if (p_details->>'mobile') !~ '^[6-9][0-9]{9}$' then raise exception 'Enter a valid 10-digit Indian mobile number';end if;
 if p_details->>'service_type' not in ('Bring to Shop','Home Visit','Home Pickup','Installation','Preventive Maintenance','Warranty Service') then raise exception 'Choose a valid service type';end if;
 if length(p_details->>'customer_name')>100 or length(p_details->>'locality')>100 or length(p_details->>'city')>100 or length(p_details->>'appliance')>100 or length(p_details->>'brand')>100 or length(p_details->>'service_address')>500 or length(p_details->>'issue')>2000 then raise exception 'Ticket field is too long';end if;
 update public.service_tickets set customer_name=trim(p_details->>'customer_name'),mobile=p_details->>'mobile',locality=trim(p_details->>'locality'),city=trim(p_details->>'city'),service_address=trim(p_details->>'service_address'),appliance=trim(p_details->>'appliance'),brand=trim(p_details->>'brand'),service_type=p_details->>'service_type',issue=trim(p_details->>'issue') where id=p_ticket;
 return jsonb_build_object('saved',true,'ticket_number',t.ticket_number);
end $$;
revoke all on function public.edit_new_service_ticket(uuid,uuid,bigint,jsonb) from public,anon,authenticated;
grant execute on function public.edit_new_service_ticket(uuid,uuid,bigint,jsonb) to service_role;