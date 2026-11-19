begin;
set local role service_role;
set local request.jwt.claims = '{"role":"service_role","sub":"00000000-0000-4000-8000-000000000001"}';
do $$
declare
 technician uuid; other_technician uuid; ticket uuid:=gen_random_uuid();
 item uuid:=gen_random_uuid(); n integer; bill public.invoices; receipt public.payments;
 payment uuid:=gen_random_uuid(); signature uuid:=gen_random_uuid(); proof uuid:=gen_random_uuid();
 inputs jsonb; actual text;
begin
 -- Use existing staff identities; no authentication accounts are created by the test.
 select user_id into technician from public.staff where active and role='technician' order by user_id limit 1;
 select user_id into other_technician from public.staff where active and role='technician' and user_id<>technician order by user_id limit 1;
 if technician is null then raise exception 'Workflow test needs one active technician'; end if;
 if other_technician is null then other_technician:=gen_random_uuid(); end if;
 insert into public.items(id,code,description,uom,purchase_price,sale_price,tax_rate)
 values(item,'TEST-'||item,'Technician workflow test','Piece',100,null,0);
 select value into n from generate_series(99999,99000,-1) value where not exists(select 1 from public.service_tickets where ticket_number=value) limit 1;
 insert into public.service_tickets(id,ticket_number,customer_name,mobile,locality,service_address,appliance,brand,service_type,issue,status,assigned_to,created_by) overriding system value
 values(ticket,n,'Workflow fixture','9999999999','Test','Test','Test','Test','Bring to Shop','Test','Assigned',technician,null);
 begin
  perform public.advance_ticket_inspection(ticket,technician,'complete','Skip start');
  raise exception 'Regression: inspection skipped start';
 exception when raise_exception then if sqlerrm<>'Start inspection before saving comments or completing it' then raise;end if;end;
 perform public.respond_ticket_assignment(ticket,technician,1,'accept','');
 perform public.advance_ticket_inspection(ticket,technician,'start','');
 perform public.advance_ticket_inspection(ticket,technician,'start','');
 perform public.advance_ticket_inspection(ticket,technician,'save','Checked compressor');
 if not exists(select 1 from public.service_tickets where id=ticket and status='In Progress' and inspected_at is not null)then raise exception 'Inspection did not start repair';end if;
 begin
  perform public.complete_service_ticket(ticket,technician,'[]','Fixed','Tested');
  raise exception 'Regression: empty parts accepted';
 exception when raise_exception then if sqlerrm<>'Add at least one part used' then raise;end if;end;
 inputs:=jsonb_build_array(jsonb_build_object('item_id',item,'quantity',1));
 begin
  perform public.complete_service_ticket(ticket,other_technician,inputs,'Fixed','Tested');
  raise exception 'Regression: wrong technician completed ticket';
 exception when raise_exception then if sqlerrm<>'Only the assigned technician can complete the repair' then raise;end if;end;
 begin
  perform public.complete_service_ticket(ticket,technician,inputs,'','');
  raise exception 'Regression: missing test accepted';
 exception when raise_exception then if sqlerrm<>'Add the work performed' then raise;end if;end;
 begin
  perform public.complete_service_ticket(ticket,technician,inputs,'Fixed','');
  raise exception 'Regression: repair skipped inspection completion';
 exception when raise_exception then if sqlerrm<>'Complete the inspection before completing the repair' then raise;end if;end;
 perform public.advance_ticket_inspection(ticket,technician,'complete','Checked compressor');
 if not exists(select 1 from public.service_tickets where id=ticket and status='Inspection Complete' and inspection_completed_at is not null)then raise exception 'Inspection milestone missing';end if;
 perform public.set_ticket_awaiting_parts(ticket,technician,inputs);
 perform public.complete_service_ticket(ticket,technician,inputs,'Replaced compressor','');
 perform public.complete_service_ticket(ticket,technician,inputs,'Replaced compressor','');
 if not exists(select 1 from public.service_tickets where id=ticket and status='Repair Complete' and completed_at is not null)then raise exception 'Completion did not save review';end if;
 begin
  perform public.receive_ticket_payment(payment,ticket,technician,2500,'Cash','',null,null,'');
  raise exception 'Regression: unsigned cash accepted';
 exception when raise_exception then if sqlerrm<>'Capture the customer signature or record why they cannot sign' then raise;end if;end;
 insert into public.ticket_media(id,ticket_id,stage,object_path,file_name,mime_type,file_size,uploaded_by,ready)
 values(signature,ticket,'signature',ticket||'/'||signature||'.png','signature.png','image/png',100,technician,true),
 (proof,ticket,'payment',ticket||'/'||proof||'.jpg','upi.jpg','image/jpeg',100,technician,true);
 receipt:=public.receive_ticket_payment(payment,ticket,technician,2500,'Cash','',null,signature,'');
 perform public.receive_ticket_payment(payment,ticket,technician,2500,'Cash','',null,signature,'');
 if (select count(*) from public.payments where ticket_id=ticket)<>1 or receipt.receipt_number is null or receipt.acknowledgement not like '%2500.00%' then raise exception 'Cash receipt duplicate or missing acknowledgement';end if;
 if not exists(select 1 from public.service_tickets where id=ticket and status='Paid, not billed')then raise exception 'Unbilled collection status incorrect';end if;
 begin
  perform public.receive_ticket_payment(gen_random_uuid(),ticket,technician,1,'Cash','',null,signature,'');
  raise exception 'Regression: signature reused';
 exception when raise_exception then if sqlerrm<>'Payment proof is unavailable or belongs to another ticket' then raise;end if;end;
 bill:=public.issue_discounted_service_invoice(ticket,500,0,'','{"name":"JYOTI REFRIGERATION."}',900000,jsonb_build_array(jsonb_build_object('item_id',item,'price',2500)),'none',0);
 if bill.total<>3000 or not exists(select 1 from public.payments where id=payment and invoice_id=bill.id) or not exists(select 1 from public.service_tickets where id=ticket and status='Billed')then raise exception 'Invoice failed to reconcile unbilled receipts';end if;
 begin
  perform public.receive_ticket_payment(gen_random_uuid(),ticket,technician,501,'UPI','',proof,null,'');
  raise exception 'Regression: overpayment accepted';
 exception when raise_exception then if sqlerrm<>'Amount exceeds the outstanding balance' then raise;end if;end;
 begin
  perform public.receive_ticket_payment(gen_random_uuid(),ticket,technician,500,'UPI','',null,null,'');
  raise exception 'Regression: UPI without proof accepted';
 exception when raise_exception then if sqlerrm<>'Attach a payment photo or screenshot for UPI' then raise;end if;end;
 perform public.receive_ticket_payment(gen_random_uuid(),ticket,technician,500,'UPI','',proof,null,'');
 if not exists(select 1 from public.service_tickets where id=ticket and status='Paid')then raise exception 'Settlement did not mark paid';end if;
 -- A second ticket covers excess collected before its final invoice and a cash signature waiver.
 ticket:=gen_random_uuid();payment:=gen_random_uuid();
 select value into n from generate_series(99999,99000,-1) value where not exists(select 1 from public.service_tickets where ticket_number=value) limit 1;
 insert into public.service_tickets(id,ticket_number,customer_name,mobile,locality,service_address,appliance,brand,service_type,issue,status,assigned_to,created_by) overriding system value
 values(ticket,n,'Excess fixture','9999999999','Test','Test','Test','Test','Bring to Shop','Test','Assigned',technician,null);
 perform public.respond_ticket_assignment(ticket,technician,1,'accept','');
 perform public.advance_ticket_inspection(ticket,technician,'start','');
 perform public.advance_ticket_inspection(ticket,technician,'complete','Inspection done');
 perform public.complete_service_ticket(ticket,technician,inputs,'Fixed','');
 perform public.receive_ticket_payment(payment,ticket,technician,2500,'Cash','',null,null,'Customer hand injury');
 bill:=public.issue_discounted_service_invoice(ticket,500,0,'','{"name":"JYOTI REFRIGERATION."}',900000,jsonb_build_array(jsonb_build_object('item_id',item,'price',1500)),'none',0);
 if bill.total<>2000 or not exists(select 1 from public.service_tickets where id=ticket and status='Paid')then raise exception 'Excess collection status incorrect';end if;
 if (select sum(amount) from public.payments where invoice_id=bill.id)-bill.total<>500 then raise exception 'Excess collection was lost';end if;
 select id into payment from public.payments where signature_media_id=signature;

 begin
  update public.payments set amount=100 where id=payment;
  raise exception 'Regression: signed amount changed';
 exception when raise_exception then if sqlerrm<>'A signed cash receipt cannot be changed' then raise;end if;end;
end $$;
rollback;
