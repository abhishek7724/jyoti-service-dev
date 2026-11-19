begin;
set local role service_role;
do $$
declare item uuid:=gen_random_uuid(); ticket uuid:=gen_random_uuid(); manager uuid; supplier uuid; n integer; order_row public.purchase_orders; lines jsonb;
begin
 select user_id into manager from public.staff where role='manager' and active limit 1;
 select id into supplier from public.suppliers limit 1;
 insert into public.items(id,code,description,uom,purchase_price,sale_price,tax_rate)values(item,'TEST-'||item,'PO fixture','Piece',100,200,0);
 select value into n from generate_series(99999,99000,-1)value where not exists(select 1 from public.service_tickets where ticket_number=value)limit 1;
 insert into public.service_tickets(id,ticket_number,customer_name,mobile,locality,service_address,appliance,brand,service_type,issue,created_by)overriding system value
 values(ticket,n,'PO fixture','9999999999','Test','Test','Test','Test','Bring to Shop','Test',null);
 lines:=jsonb_build_array(jsonb_build_object('item_id',item,'quantity',2,'unit_price',100));
 order_row:=public.create_purchase_order(supplier,ticket,manager,lines);
 begin
  perform public.create_purchase_order(supplier,ticket,manager,lines);
  raise exception 'Regression: duplicate ticket PO created';
 exception when raise_exception then if sqlerrm not like 'PO #% is already created for this ticket.%' then raise;end if;end;
 if (select count(*) from public.purchase_orders where ticket_id=ticket)<>1 then raise exception 'Wrong ticket PO count';end if;
 perform public.create_purchase_order(supplier,null,manager,lines);
 perform public.create_purchase_order(supplier,null,manager,lines);
end $$;
rollback;
