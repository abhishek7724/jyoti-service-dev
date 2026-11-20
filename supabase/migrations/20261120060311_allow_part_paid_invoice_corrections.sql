create or replace function public.revise_unpaid_invoice(p_invoice uuid,p_user uuid,p_revision integer,p_name text,p_address text,p_gstin text,p_prices jsonb,p_discount_type text,p_discount_value numeric,p_note text)
returns public.invoices language plpgsql set search_path='' as $$
declare bill public.invoices%rowtype; ticket uuid; rows jsonb; net numeric; cgst_amount numeric; sgst_amount numeric; gross numeric; discount numeric; discount_rate numeric; adjustment numeric; received numeric;
begin
 if not exists(select 1 from public.staff where user_id=p_user and active and role in ('manager','billing'))then raise exception 'Only managers or billing staff can correct invoices';end if;
 select ticket_id into strict ticket from public.invoices where id=p_invoice;
 perform 1 from public.service_tickets where id=ticket for update;
 select * into strict bill from public.invoices where id=p_invoice for update;
 select coalesce(sum(amount),0) into received from public.payments where invoice_id=p_invoice or ticket_id=ticket;
 if received>0 and received>=bill.total then raise exception 'Fully paid invoices can no longer be edited';end if;
 if p_revision is distinct from bill.revision then raise exception 'This invoice changed. Reopen it before saving your correction';end if;
 if length(trim(coalesce(p_name,'')))=0 or length(p_name)>100 or length(trim(coalesce(p_address,'')))=0 or length(p_address)>1000 then raise exception 'Enter the customer name and billing address';end if;
 if p_discount_type is null or p_discount_type not in ('none','percent','fixed') or p_discount_value is null or p_discount_value<0 or (p_discount_type='percent' and p_discount_value>100)then raise exception 'Enter a valid discount';end if;
 if jsonb_typeof(p_prices) is distinct from 'array' or jsonb_array_length(p_prices)<>jsonb_array_length(bill.lines) then raise exception 'Review every invoice line';end if;
 if exists(select 1 from jsonb_to_recordset(p_prices) as price(line_index integer,unit_price numeric,tax_rate numeric) group by line_index
  having line_index is null or min(line_index)<0 or max(line_index)>=jsonb_array_length(bill.lines) or count(*)<>1 or count(unit_price)<>1 or min(unit_price)<0 or max(unit_price)>9999999 or count(tax_rate)<>1 or min(tax_rate)<0 or max(tax_rate)>100)then raise exception 'Review the invoice prices and tax rates';end if;
 with itemized as (
  select (entry.ordinality-1)::integer line_key,entry.line,price.unit_price,price.tax_rate,
   round((entry.line->>'quantity')::numeric * price.unit_price,2) base
  from jsonb_array_elements(bill.lines) with ordinality as entry(line,ordinality)
  join jsonb_to_recordset(p_prices) as price(line_index integer,unit_price numeric,tax_rate numeric)on price.line_index=entry.ordinality-1
 ), original as (
  select *,base+2*round(base*tax_rate/200,2)line_gross from itemized
 ), running as (
  select *,sum(line_gross)over()original_total,sum(line_gross)over(order by line_key)gross_to_line from original
 ), discounts as (
  select *,case p_discount_type when 'percent' then round(original_total*p_discount_value/100,2)when 'fixed' then p_discount_value else 0 end discount_total from running
 ), allocation as (
  select *,round(discount_total*gross_to_line/nullif(original_total,0),2)-round(discount_total*(gross_to_line-line_gross)/nullif(original_total,0),2)line_discount from discounts
 ), taxable as (
  select *,case when line_discount=0 then base else least(base,round((line_gross-line_discount)/(1+tax_rate/100),2))end amount from allocation
 ), taxed as (
  select *,round(amount*tax_rate/200,2)cgst,round(amount*tax_rate/200,2)sgst from taxable
 )
 select jsonb_agg(line||jsonb_build_object('unit_price',unit_price,'tax_rate',tax_rate,'base_before_discount',base,'amount',amount,'cgst',cgst,'sgst',sgst)order by line_key),
  sum(amount),sum(cgst),sum(sgst),max(original_total),max(discount_total)
 into rows,net,cgst_amount,sgst_amount,gross,discount from taxed;
 if gross is null or gross<=0 then raise exception 'Invoice total before discount must be positive';end if;
 if discount>gross then raise exception 'Discount cannot exceed the invoice total';end if;
 if gross-discount<received then raise exception 'Corrected total cannot be less than the amount already received (Rs. %)',received;end if;
 if gross>9999999999.99 then raise exception 'Invoice total exceeds the supported amount';end if;
 discount_rate:=case when p_discount_type='percent' then p_discount_value else round(discount/gross*100,2)end;
 adjustment:=gross-discount-net-cgst_amount-sgst_amount;
 insert into public.invoice_revision_history(invoice_id,revision,snapshot,edited_by,note)values(bill.id,bill.revision,to_jsonb(bill),p_user,coalesce(p_note,''));
 update public.invoices set customer_name=p_name,service_address=p_address,customer_gstin=p_gstin,lines=rows,
  subtotal=net,cgst=cgst_amount,sgst=sgst_amount,total=gross-discount,gross_total=gross,discount_amount=discount,discount_percent=discount_rate,rounding_adjustment=adjustment,
  revision=bill.revision+1,last_edited_at=now(),last_edited_by=p_user where id=p_invoice returning * into bill;
 return bill;
end $$;
revoke all on function public.revise_unpaid_invoice(uuid,uuid,integer,text,text,text,jsonb,text,numeric,text)from public,anon,authenticated;
grant execute on function public.revise_unpaid_invoice(uuid,uuid,integer,text,text,text,jsonb,text,numeric,text)to service_role;
