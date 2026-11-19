begin;
set local role service_role;
set local request.jwt.claims='{"role":"service_role","sub":"00000000-0000-4000-8000-000000000001"}';
do $$
declare technician uuid; manager uuid; ticket uuid:=gen_random_uuid(); n integer; version bigint; previous_activity bigint;
begin
 select user_id into technician from public.staff where active and role='technician' limit 1;
 select user_id into manager from public.staff where active and role='manager' limit 1;
 if technician is null or manager is null then raise exception 'Assignment test needs a technician and manager';end if;
 select value into n from generate_series(99999,99000,-1) value where not exists(select 1 from public.service_tickets where ticket_number=value) limit 1;
 insert into public.service_tickets(id,ticket_number,customer_name,mobile,locality,service_address,appliance,brand,service_type,issue,status,assigned_to,created_by) overriding system value
 values(ticket,n,'Assignment fixture','9999999999','Test','Test','Test','Test','Bring to Shop','Test','Assigned',technician,null);
 begin
  perform public.advance_ticket_inspection(ticket,technician,'start','');
  raise exception 'Regression: started before acceptance';
 exception when raise_exception then if sqlerrm<>'Accept the assignment before starting inspection' then raise;end if;end;
 begin
  perform public.respond_ticket_assignment(ticket,manager,1,'accept','');
  raise exception 'Regression: another staff member accepted';
 exception when raise_exception then if sqlerrm<>'Only the assigned technician can respond to this assignment' then raise;end if;end;
 perform public.respond_ticket_assignment(ticket,technician,1,'reject','Unavailable today');
 perform public.respond_ticket_assignment(ticket,technician,1,'reject','Unavailable today');
 if not exists(select 1 from public.service_tickets where id=ticket and status='Assignment Rejected' and rejection_reason='Unavailable today' and assigned_to=technician and assignment_responded_at is not null)then raise exception 'Rejection state was not retained';end if;
 begin
  perform public.respond_ticket_assignment(ticket,technician,1,'accept','');
  raise exception 'Regression: changed rejection into acceptance';
 exception when raise_exception then if sqlerrm<>'This assignment has already been answered' then raise;end if;end;
 perform set_config('request.jwt.claims',jsonb_build_object('role','service_role','sub',manager)::text,true);
 execute 'set local role authenticated';
 update public.service_tickets set assigned_to=null where id=ticket;
 update public.service_tickets set assigned_to=technician where id=ticket;
 execute 'set local role service_role';
 if not exists(select 1 from public.service_tickets where id=ticket and status='Assigned' and rejection_reason='' and assignment_responded_at is null and assignment_version=3)then raise exception 'Reassignment did not reset acceptance state';end if;
 begin
  perform public.respond_ticket_assignment(ticket,technician,1,'accept','');
  raise exception 'Regression: stale assignment response accepted';
 exception when raise_exception then if sqlerrm<>'This assignment has changed. Open the latest ticket before responding' then raise;end if;end;
 perform public.respond_ticket_assignment(ticket,technician,3,'accept','');
 perform public.respond_ticket_assignment(ticket,technician,3,'accept','');
 perform public.advance_ticket_inspection(ticket,technician,'start','');
 if not exists(select 1 from public.service_tickets where id=ticket and status='In Progress')then raise exception 'Accepted assignment did not start inspection';end if;
 select activity_version into previous_activity from public.service_tickets where id=ticket;
 insert into public.ticket_media(id,ticket_id,stage,object_path,file_name,mime_type,file_size,uploaded_by,ready)
 values(gen_random_uuid(),ticket,'inspection',ticket||'/fixture.jpg','fixture.jpg','image/jpeg',100,technician,true);
 select activity_version into version from public.service_tickets where id=ticket;
 if version<=previous_activity then raise exception 'Photo did not publish ticket activity';end if;
 if has_function_privilege('anon','public.respond_ticket_assignment(uuid,uuid,integer,text,text)','execute')then raise exception 'Anonymous assignment response allowed';end if;
end $$;
rollback;
