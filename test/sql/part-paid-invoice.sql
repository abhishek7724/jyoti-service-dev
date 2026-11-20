begin;
set local role service_role;
set local request.jwt.claims='{"role":"service_role","sub":"00000000-0000-4000-8000-000000000001"}';
do $$
declare actor uuid; ticket uuid:=gen_random_uuid(); item uuid:=gen_random_uuid(); n integer; bill public.invoices; prices jsonb; receipt uuid:=gen_random_uuid();
begin
 select user_id into actor from public.staff where active and role in ('manager','billing')limit 1;
 insert into public.items(id,code,description,uom,purchase_price,sale_price,tax_rate)values(item,'TEST-'||item,'Partial-payment correction','Piece',100,500,0);
 select value into n from generate_series(99999,99000,-1)value where not exists(select 1 from public.service_tickets where ticket_number=value)limit 1;
 insert into public.service_tickets(id,ticket_number,customer_name,mobile,locality,service_address,appliance,brand,service_type,issue,status,parts_reviewed,created_by)overriding system value
 values(ticket,n,'Part-paid fixture','9999999999','Test','Test','Test','Test','Bring to Shop','Test','Repair Complete',true,null);
 insert into public.ticket_parts(ticket_id,item_id,quantity)values(ticket,item,1);
 bill:=public.issue_discounted_service_invoice(ticket,500,0,'','{"name":"JYOTI REFRIGERATION."}',900000,jsonb_build_array(jsonb_build_object('item_id',item,'price',500)),'none',0);
 perform public.record_payment(receipt,bill.id,null,400,'UPI','Part-paid fixture');
 prices:='[{"line_index":0,"unit_price":700,"tax_rate":0},{"line_index":1,"unit_price":500,"tax_rate":0}]';
 bill:=public.revise_unpaid_invoice(bill.id,actor,1,'Part-paid fixture','Corrected address','',prices,'none',0,'Part-paid correction');
 if bill.total<>1200 or bill.revision<>2 then raise exception 'Part-paid correction failed';end if;
 if not exists(select 1 from public.payments where id=receipt and amount=400 and invoice_id=bill.id) or (select count(*) from public.payments where invoice_id=bill.id)<>1 then raise exception 'Payment was modified';end if;
 if not exists(select 1 from public.service_tickets where id=ticket and status='Billed')then raise exception 'Part-paid ticket did not remain Billed';end if;
 begin
  perform public.revise_unpaid_invoice(bill.id,actor,2,'Part-paid fixture','Corrected address','',prices,'fixed',900,'Too low');
  raise exception 'Regression: total below amount received allowed';
 exception when raise_exception then if sqlerrm not like 'Corrected total cannot be less than the amount already received%'then raise;end if;end;
 bill:=public.revise_unpaid_invoice(bill.id,actor,2,'Part-paid fixture','Corrected address','',prices,'fixed',800,'Settled at received amount');
 if bill.total<>400 or not exists(select 1 from public.service_tickets where id=ticket and status='Paid')then raise exception 'Exact received total did not settle invoice';end if;
 begin
  perform public.revise_unpaid_invoice(bill.id,actor,3,'Part-paid fixture','Corrected address','',prices,'none',0,'');
  raise exception 'Regression: fully paid invoice edited';
 exception when raise_exception then if sqlerrm<>'Fully paid invoices can no longer be edited'then raise;end if;end;
end $$;
rollback;
