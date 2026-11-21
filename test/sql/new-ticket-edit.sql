begin;
do $$
declare t public.service_tickets%rowtype; actor uuid; tech uuid; d jsonb; blocked boolean;
begin
 select user_id into strict actor from public.staff where active and role='manager' order by user_id limit 1;
 select user_id into strict tech from public.staff where active and role='technician' order by user_id limit 1;
 select * into strict t from public.service_tickets where status='New' and assigned_to is null and assignment_version=1 order by ticket_number limit 1 for update;
 perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated')::text,true);
 d:=jsonb_build_object('customer_name','Rollback edit test','mobile',t.mobile,'locality',t.locality,'city',t.city,'service_address','Rollback corrected address','appliance',t.appliance,'brand',t.brand,'service_type',t.service_type,'issue',t.issue);
 perform public.edit_new_service_ticket(t.id,actor,t.activity_version,d);
 if not exists(select 1 from public.service_tickets where id=t.id and customer_name='Rollback edit test' and service_address='Rollback corrected address' and ticket_number=t.ticket_number and created_at=t.created_at and intake_source=t.intake_source) then raise exception 'New ticket edit failed';end if;
 blocked:=false;begin perform public.edit_new_service_ticket(t.id,actor,t.activity_version,d);exception when raise_exception then blocked:=true;end;if not blocked then raise exception 'Stale form was allowed';end if;
 blocked:=false;begin perform public.edit_new_service_ticket(t.id,tech,t.activity_version+1,d);exception when raise_exception then blocked:=true;end;if not blocked then raise exception 'Technician edit was allowed';end if;
 update public.service_tickets set assigned_to=tech where id=t.id;
 blocked:=false;begin perform public.edit_new_service_ticket(t.id,actor,(select activity_version from public.service_tickets where id=t.id),d);exception when raise_exception then blocked:=true;end;if not blocked then raise exception 'Assigned ticket edit was allowed';end if;
 blocked:=false;begin update public.service_tickets set customer_name='Forbidden' where id=t.id;exception when raise_exception then blocked:=true;end;if not blocked then raise exception 'Direct update bypassed lock';end if;
 perform public.respond_ticket_assignment(t.id,tech,(select assignment_version from public.service_tickets where id=t.id),'accept','');
 perform public.advance_ticket_inspection(t.id,tech,'start','');
 blocked:=false;begin perform public.edit_new_service_ticket(t.id,actor,(select activity_version from public.service_tickets where id=t.id),d);exception when raise_exception then blocked:=true;end;if not blocked then raise exception 'In-progress ticket edit was allowed';end if;
 update public.service_tickets set assigned_to=null where id=t.id;
 blocked:=false;begin perform public.edit_new_service_ticket(t.id,actor,(select activity_version from public.service_tickets where id=t.id),d);exception when raise_exception then blocked:=true;end;if not blocked then raise exception 'Previously assigned ticket edit was allowed';end if;
end $$;
rollback;
select 'PASS: new ticket edit, stale version, role, assigned, in-progress, direct update and reassignment guards; all changes rolled back' result;
