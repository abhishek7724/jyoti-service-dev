begin;
set local role service_role;
set local request.jwt.claims='{"role":"service_role","sub":"00000000-0000-4000-8000-000000000001"}';
do $$
declare actor uuid; tech uuid; ticket uuid:=gen_random_uuid(); item uuid:=gen_random_uuid(); n integer; bill public.invoices; original_number text; prices jsonb;
begin
 select user_id into actor from public.staff where active and role in ('manager','billing') limit 1;
 select user_id into tech from public.staff where active and role='technician' limit 1;
 insert into public.items(id,code,description,uom,purchase_price,sale_price,tax_rate)values(item,'TEST-'||item,'Correction part','Piece',100,500,0);
 select value into n from generate_series(99999,99000,-1)value where not exists(select 1 from public.service_tickets where ticket_number=value)limit 1;
 insert into public.service_tickets(id,ticket_number,customer_name,mobile,locality,service_address,appliance,brand,service_type,issue,status,parts_reviewed,created_by)overriding system value
 values(ticket,n,'Correction fixture','9999999999','Test','Test','Test','Test','Bring to Shop','Test','Repair Complete',true,null);
 insert into public.ticket_parts(ticket_id,item_id,quantity)values(ticket,item,1);
 bill:=public.issue_discounted_service_invoice(ticket,500,0,'','{"name":"JYOTI REFRIGERATION."}',900000,jsonb_build_array(jsonb_build_object('item_id',item,'price',500)),'none',0);
 original_number:=bill.number;
 prices:='[{"line_index":0,"unit_price":1000,"tax_rate":0},{"line_index":1,"unit_price":500,"tax_rate":0}]';
 begin
  perform public.revise_unpaid_invoice(bill.id,tech,1,'Correct customer','Correct address','',prices,'fixed',250,'');
  raise exception 'Regression: technician edited an invoice';
 exception when raise_exception then if sqlerrm<>'Only managers or billing staff can correct invoices' then raise;end if;end;
 bill:=public.revise_unpaid_invoice(bill.id,actor,1,'Correct customer','Correct address','',prices,'fixed',250,'Price correction');
 if bill.number<>original_number or bill.total<>1250 or bill.discount_percent<>16.67 or bill.revision<>2 or bill.customer_name<>'Correct customer' then raise exception 'Incorrect invoice correction';end if;
 if not exists(select 1 from public.invoice_revision_history where invoice_id=bill.id and revision=1 and (snapshot->>'total')::numeric=1000)then raise exception 'Original invoice not preserved';end if;
 begin
  perform public.revise_unpaid_invoice(bill.id,actor,1,'Correct customer','Correct address','',prices,'none',0,'');
  raise exception 'Regression: stale invoice overwritten';
 exception when raise_exception then if sqlerrm<>'This invoice changed. Reopen it before saving your correction' then raise;end if;end;
 bill:=public.revise_unpaid_invoice(bill.id,actor,2,'Correct customer','Correct address','',prices,'percent',5,'');
 if bill.total<>1425 or bill.discount_amount<>75 or bill.revision<>3 then raise exception 'Percentage correction incorrect';end if;
 prices:='[{"line_index":0,"unit_price":1000,"tax_rate":18},{"line_index":1,"unit_price":500,"tax_rate":0}]';
 bill:=public.revise_unpaid_invoice(bill.id,actor,3,'Correct customer','Correct address','',prices,'fixed',250,'GST correction');
 if bill.total<>1430 or bill.subtotal+bill.cgst+bill.sgst+bill.rounding_adjustment<>1430 or bill.revision<>4 then raise exception 'GST correction did not reconcile';end if;
 perform public.record_payment(gen_random_uuid(),bill.id,null,100,'Cash','Revision fixture');
 begin
  perform public.revise_unpaid_invoice(bill.id,actor,4,'Correct customer','Correct address','',prices,'none',0,'');
  raise exception 'Regression: paid invoice edited';
 exception when raise_exception then if sqlerrm<>'This invoice has a recorded payment and can no longer be edited' then raise;end if;end;
 if (select count(*) from public.invoice_revision_history where invoice_id=bill.id )<>3 then raise exception 'Unexpected revision history';end if;
 if has_function_privilege('authenticated','public.revise_unpaid_invoice(uuid,uuid,integer,text,text,text,jsonb,text,numeric,text)','execute')then raise exception 'Invoice revision exposed to direct calls';end if;
end $$;
rollback;
