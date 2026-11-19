create unique index purchase_orders_one_per_ticket on public.purchase_orders(ticket_id) where ticket_id is not null;
create trigger touch_ticket_activity after insert or update or delete on public.purchase_orders for each row execute function jyoti_private.touch_related_ticket_activity();

create or replace function public.create_purchase_order(p_supplier uuid,p_ticket uuid,p_user uuid,p_lines jsonb)
returns public.purchase_orders language plpgsql set search_path='' as $$
declare po public.purchase_orders%rowtype; line_count integer; existing_number bigint;
begin
 if p_ticket is not null then
  perform 1 from public.service_tickets where id=p_ticket for update;
  select po_number into existing_number from public.purchase_orders where ticket_id=p_ticket;
  if found then raise exception 'PO #% is already created for this ticket. Open it in Purchasing.',existing_number;end if;
 end if;
 insert into public.purchase_orders(supplier_id,ticket_id,created_by)values(p_supplier,p_ticket,p_user)returning * into po;
 insert into public.purchase_lines(po_id,item_id,description,uom,quantity,unit_price)
 select po.id,i.id,i.description,i.uom,l.quantity,l.unit_price
 from jsonb_to_recordset(p_lines) as l(item_id uuid,quantity numeric,unit_price numeric)
 join public.items i on i.id=l.item_id and i.active;
 get diagnostics line_count=row_count;
 if line_count=0 or line_count<>jsonb_array_length(p_lines)then raise exception 'Each purchase line must reference an active item';end if;
 return po;
end $$;
