
create extension if not exists pg_net with schema extensions;
create schema if not exists jyoti_notifications;
revoke all on schema jyoti_notifications from public, anon, authenticated;
create table jyoti_notifications.whatsapp_settings (
 id boolean primary key default true check(id),
 enabled boolean not null default false,
 test_recipient text not null default '919685858101' check(test_recipient='919685858101'),
 phone_number_id text not null default '1403299919539677' check(phone_number_id='1403299919539677'),
 token_secret_name text not null default 'jyoti_whatsapp_test_token'
);
insert into jyoti_notifications.whatsapp_settings(id) values(true);
create table jyoti_notifications.invoice_whatsapp (
 invoice_id uuid primary key references public.invoices(id),
 invoice_number text not null,
 created_at timestamptz not null default now(),
 state text not null default 'waiting_for_config' check(state in ('waiting_for_config','submitted','accepted','failed','unknown')),
 request_id bigint,
 submitted_at timestamptz,
 message_id text,
 http_status integer,
 error_code text
);
alter table jyoti_notifications.whatsapp_settings enable row level security;
alter table jyoti_notifications.invoice_whatsapp enable row level security;
revoke all on all tables in schema jyoti_notifications from public,anon,authenticated;
create function jyoti_notifications.dispatch_invoice(p_invoice uuid)
returns bigint language plpgsql security definer set search_path='' as $fn$
declare cfg jyoti_notifications.whatsapp_settings%rowtype; job jyoti_notifications.invoice_whatsapp%rowtype; token text; rid bigint; caller uuid := auth.uid();
begin
 if caller is not null then
   if not exists(select 1 from public.staff where user_id=caller and active and role in ('manager','billing')) then
     raise exception 'Billing staff required' using errcode='42501';
   end if;
 elsif coalesce(nullif(current_setting('role',true),'none'),session_user) not in ('postgres','service_role','supabase_admin') then
   raise exception 'Backend role required' using errcode='42501';
 end if;
 select * into job from jyoti_notifications.invoice_whatsapp where invoice_id=p_invoice for update;
 if not found or job.state <> 'waiting_for_config' then return null; end if;
 select * into cfg from jyoti_notifications.whatsapp_settings where id=true;
 if not cfg.enabled then return null; end if;
 select decrypted_secret into token from vault.decrypted_secrets where name=cfg.token_secret_name;
 if token is null or length(token)<40 then return null; end if;
 begin
 rid := net.http_post(
 url := 'https://graph.facebook.com/v25.0/' || cfg.phone_number_id || '/messages',
 headers := jsonb_build_object('Authorization','Bearer '||token,'Content-Type','application/json'),
 body := jsonb_build_object('messaging_product','whatsapp','to',cfg.test_recipient,'type','template',
 'template',jsonb_build_object('name','hello_world','language',jsonb_build_object('code','en_US'))),
 timeout_milliseconds := 10000);
 update jyoti_notifications.invoice_whatsapp set state='submitted',request_id=rid,submitted_at=now(),error_code=null where invoice_id=p_invoice;
 exception when others then
 update jyoti_notifications.invoice_whatsapp set state='failed',error_code=sqlstate where invoice_id=p_invoice;
 return null;
 end;
 return rid;
end $fn$;
revoke all on function jyoti_notifications.dispatch_invoice(uuid) from public,anon,authenticated;
create function jyoti_notifications.on_invoice_created()
returns trigger language plpgsql security definer set search_path='' as $fn$
declare caller uuid:=auth.uid();
begin
 if caller is not null then
   if not exists(select 1 from public.staff where user_id=caller and active and role in ('manager','billing')) then return new; end if;
 elsif coalesce(nullif(current_setting('role',true),'none'),session_user) not in ('postgres','service_role','supabase_admin') then return new;
 end if;
 begin
 insert into jyoti_notifications.invoice_whatsapp(invoice_id,invoice_number) values(new.id,new.number) on conflict(invoice_id) do nothing;
 perform jyoti_notifications.dispatch_invoice(new.id);
 exception when others then
 raise warning 'Invoice WhatsApp enqueue failed; SQLSTATE %',sqlstate;
 end;
 return new;
end $fn$;
revoke all on function jyoti_notifications.on_invoice_created() from public,anon,authenticated;
create trigger invoice_created_whatsapp_test after insert on public.invoices for each row execute function jyoti_notifications.on_invoice_created();
comment on table jyoti_notifications.invoice_whatsapp is 'Test-only Hello World notification per new invoice. Recipient fixed to verified test number. Accepted is not delivered. No retries after submission to avoid duplicate messages.';
