create or replace function public.billing_workspace(
 p_tab text default 'invoices',p_search text default '',p_status text default 'all',
 p_limit integer default 25,p_offset integer default 0,p_from date default null,p_to date default null)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare result jsonb;
begin
 if p_tab not in ('invoices','ready') or p_status not in ('all','pending','part_paid','paid','excess')
 or p_limit not in (10,25,50) or p_offset<0 or p_offset>10000000 or length(p_search)>100
 or (p_from is not null and p_to is not null and p_from>p_to) then
  raise exception 'Choose valid billing filters';
 end if;
 with invoice_base as materialized (
  select i.*,t.ticket_number,t.mobile,
   coalesce((select sum(p.amount) from public.payments p where p.invoice_id=i.id or p.ticket_id=i.ticket_id),0) received
  from public.invoices i join public.service_tickets t on t.id=i.ticket_id
  where (p_from is null or i.issued_on>=p_from) and (p_to is null or i.issued_on<=p_to)
  and (p_search='' or strpos(lower(i.number||' '||i.customer_name||' '||t.ticket_number::text||' '||t.mobile),lower(p_search))>0)
 ), invoice_amounts as materialized (
  select b.*,greatest(total-received,0) due,greatest(received-total,0) excess,
   case when received>=total then 'paid' when received>0 then 'part_paid' else 'pending' end payment_status
  from invoice_base b
 ), ready_base as materialized (
  select t.id,t.ticket_number,t.customer_name,t.appliance,t.mobile,t.created_at,t.status,
   coalesce((select sum(p.amount) from public.payments p where p.ticket_id=t.id),0) received
  from public.service_tickets t where t.status in ('Repair Complete','Paid, not billed')
  and not exists(select 1 from public.invoices i where i.ticket_id=t.id)
  and (p_from is null or (t.created_at at time zone 'Asia/Kolkata')::date>=p_from)
  and (p_to is null or (t.created_at at time zone 'Asia/Kolkata')::date<=p_to)
  and (p_search='' or strpos(lower(t.customer_name||' '||t.ticket_number::text||' '||t.mobile),lower(p_search))>0)
 ), filtered as materialized (
  select b.* from invoice_amounts b where p_status='all' or b.payment_status=p_status or (p_status='excess' and b.excess>0)
 ), counts as (
  select (select count(*) from filtered) invoice_count,(select count(*) from ready_base) ready_count
 ), paging as (
  select *,least(p_offset,greatest(0,((case when p_tab='ready' then ready_count else invoice_count end-1)/p_limit)*p_limit))::integer effective_offset from counts
 ), invoice_page as (
  select b.* from filtered b order by issued_on desc,substring(number from '^([0-9]+)')::numeric desc nulls last,id
  limit p_limit offset (select effective_offset from paging)
 ), ready_page as (
  select b.* from ready_base b order by created_at desc,id limit p_limit offset (select effective_offset from paging)
 )
 select jsonb_build_object(
  'tab',p_tab,'offset',(select effective_offset from paging),'limit',p_limit,
  'total',(select case when p_tab='ready' then ready_count else invoice_count end from paging),
  'counts',jsonb_build_object('invoices',(select count(*) from invoice_amounts),'ready',(select ready_count from paging)),
  'summary',(select jsonb_build_object('due',coalesce(sum(due),0),'pending',count(*) filter(where payment_status='pending'),
    'part_paid',count(*) filter(where payment_status='part_paid'),'excess',coalesce(sum(excess),0)) from invoice_amounts),
  'invoices',case when p_tab='invoices' then coalesce((select jsonb_agg(
    (to_jsonb(b)-'ticket_number'-'mobile') || jsonb_build_object('service_tickets',jsonb_build_object('ticket_number',b.ticket_number,'mobile',b.mobile),
    'payments',coalesce((select jsonb_agg(jsonb_build_object('amount',p.amount,'method',p.method,'reference',p.reference,'paid_at',p.paid_at))
      from public.payments p where p.invoice_id=b.id or p.ticket_id=b.ticket_id),'[]'::jsonb)))
    from invoice_page b),'[]'::jsonb) else '[]'::jsonb end,
  'completed',case when p_tab='ready' then coalesce((select jsonb_agg(to_jsonb(b)) from ready_page b),'[]'::jsonb) else '[]'::jsonb end
 ) into result;
 return result;
end $$;
revoke all on function public.billing_workspace(text,text,text,integer,integer,date,date) from public,anon,authenticated;
grant execute on function public.billing_workspace(text,text,text,integer,integer,date,date) to service_role;
