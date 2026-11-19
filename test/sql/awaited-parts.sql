begin;
set local role service_role;
set local request.jwt.claims='{"role":"service_role","sub":"00000000-0000-4000-8000-000000000001"}';
do $$
declare tech uuid; ticket uuid:=gen_random_uuid(); item uuid:=gen_random_uuid(); n integer; revision bigint;
begin
 select user_id into tech from public.staff where role='technician' and active limit 1;
 insert into public.items(id,code,description,uom,purchase_price,sale_price,tax_rate)values(item,'TEST-'||item,'Awaited capacitor','Piece',100,200,0);
 select value into n from generate_series(99999,99000,-1) value where not exists(select 1 from public.service_tickets where ticket_number=value)limit 1;
 insert into public.service_tickets(id,ticket_number,customer_name,mobile,locality,service_address,appliance,brand,service_type,issue,status,assigned_to,created_by)overriding system value
 values(ticket,n,'Parts fixture','9999999999','Test','Test','Test','Test','Bring to Shop','Test','Inspection Complete',tech,null);
 begin
  update public.service_tickets set status='Awaiting Parts' where id=ticket;
  raise exception 'Regression: no awaited parts accepted';
 exception when raise_exception then if sqlerrm<>'Select at least one awaited part and quantity' then raise;end if;end;
 perform public.set_ticket_awaiting_parts(ticket,tech,jsonb_build_array(jsonb_build_object('item_id',item,'quantity',2)));
 if not exists(select 1 from public.ticket_required_parts where ticket_id=ticket and quantity=2 and requested_by=tech)then raise exception 'Part or quantity not saved';end if;
 if not exists(select 1 from public.service_tickets where id=ticket and status='Awaiting Parts')then raise exception 'Awaiting status not saved';end if;
 if exists(select 1 from public.ticket_parts where ticket_id=ticket)then raise exception 'Awaited parts were incorrectly consumed';end if;
 select activity_version into revision from public.service_tickets where id=ticket;
 perform public.set_ticket_awaiting_parts(ticket,tech,jsonb_build_array(jsonb_build_object('item_id',item,'quantity',3)));
 if not exists(select 1 from public.ticket_required_parts where ticket_id=ticket and quantity=3)then raise exception 'Awaited quantity not editable';end if;
 if not exists(select 1 from public.service_tickets where id=ticket and activity_version>revision)then raise exception 'Awaited quantity change did not publish activity';end if;
end $$;
rollback;
