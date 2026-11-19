-- Run against a configured Jyoti database. All fixtures roll back.
-- A non-staff caller causes the invoice notification trigger to skip test invoices.
begin;
set local role service_role;
set local request.jwt.claims = '{"role":"service_role","sub":"00000000-0000-4000-8000-000000000001"}';
do $$
declare
  item uuid := gen_random_uuid();
  ticket uuid := gen_random_uuid();
  free_ticket uuid := gen_random_uuid();
  bill public.invoices;
  first_payment uuid := gen_random_uuid();
  final_payment uuid := gen_random_uuid();
  number integer;
  actual text;
begin
  insert into public.items(id,code,description,uom,purchase_price,sale_price,tax_rate,brand,model)
    values(item,'TEST-'||item,'Lifecycle regression fixture','Piece',10,null,0,'LG','Lifecycle model');
  if not exists(select 1 from public.items where id = item and sale_price is null and brand = 'LG' and model = 'Lifecycle model') then
    raise exception 'Optional customer price, brand or model was not saved';
  end if;
  select n into number from generate_series(99999,99000,-1) n
    where not exists(select 1 from public.service_tickets where ticket_number = n) limit 1;
  insert into public.service_tickets(id,ticket_number,customer_name,mobile,locality,service_address,
    appliance,brand,service_type,issue,status,parts_reviewed,created_by) overriding system value
    values(ticket,number,'Lifecycle regression','9999999999','Test','Test','Test','Test',
      'Bring to Shop','Lifecycle regression','Repair Complete',true,null);
  insert into public.ticket_parts(ticket_id,item_id,quantity) values(ticket,item,1);
  bill := public.issue_discounted_service_invoice(ticket,500,0,'','{"name":"JYOTI REFRIGERATION."}',900000,
    jsonb_build_array(jsonb_build_object('item_id',item,'price',500)),'none',0);
  select status into actual from public.service_tickets where id = ticket;
  if actual <> 'Billed' then raise exception 'Invoice issuance did not mark ticket Billed'; end if;

  perform public.record_payment(first_payment,bill.id,null,400,'Cash','Lifecycle regression');
  select status into actual from public.service_tickets where id = ticket;
  if actual <> 'Billed' then raise exception 'Partial payment must remain Billed'; end if;
  perform public.record_payment(final_payment,bill.id,null,600,'Cash','Lifecycle regression');
  select status into actual from public.service_tickets where id = ticket;
  if actual <> 'Paid' then raise exception 'Full payment did not mark ticket Paid'; end if;
  perform public.record_payment(final_payment,bill.id,null,600,'Cash','Lifecycle regression');
  if (select count(*) from public.payments where invoice_id = bill.id) <> 2 then
    raise exception 'Payment retry created a duplicate';
  end if;
  if (public.issue_discounted_service_invoice(ticket,500,0,'','{"name":"JYOTI REFRIGERATION."}',900000,
    jsonb_build_array(jsonb_build_object('item_id',item,'price',500)),'none',0)).id <> bill.id then
    raise exception 'Invoice retry created a duplicate';
  end if;

  begin
    perform public.save_ticket_parts(ticket,null,jsonb_build_array(jsonb_build_object('item_id',item,'quantity',2)));
    raise exception 'Regression failure: settled ticket parts were changed';
  exception when raise_exception then
    if sqlerrm <> 'Only the assigned technician can record parts before completion' then raise; end if;
  end;
  begin
    update public.service_tickets set status = 'Billed' where id = ticket;
    raise exception 'Regression failure: settled ticket was manually downgraded';
  exception when raise_exception then
    if sqlerrm <> 'Ticket status must match its invoice and payments' then raise; end if;
  end;
  select n into number from generate_series(99999,99000,-1) n
    where not exists(select 1 from public.service_tickets where ticket_number = n) limit 1;
  insert into public.service_tickets(id,ticket_number,customer_name,mobile,locality,service_address,
    appliance,brand,service_type,issue,status,parts_reviewed,created_by) overriding system value
    values(free_ticket,number,'Lifecycle regression','9999999999','Test','Test','Test','Test',
      'Bring to Shop','Lifecycle regression','Repair Complete',true,null);
  insert into public.ticket_parts(ticket_id,item_id,quantity) values(free_ticket,item,1);
  bill := public.issue_discounted_service_invoice(free_ticket,500,0,'','{"name":"JYOTI REFRIGERATION."}',900000,
    jsonb_build_array(jsonb_build_object('item_id',item,'price',500)),'percent',100);
  select status into actual from public.service_tickets where id = free_ticket;
  if actual <> 'Paid' or bill.total <> 0 then raise exception 'Fully discounted invoice must have no outstanding balance'; end if;
end
$$;
rollback;
