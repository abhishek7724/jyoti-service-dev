CREATE OR REPLACE FUNCTION jyoti_notifications.dispatch_invoice(p_invoice uuid)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare cfg jyoti_notifications.whatsapp_settings%rowtype; job jyoti_notifications.invoice_whatsapp%rowtype; token text; rid bigint; caller uuid:=auth.uid(); ts text; payload jsonb; sig text;
begin
 if caller is not null then
   if not exists(select 1 from public.staff where user_id=caller and active and role in ('manager','billing')) then raise exception 'Billing staff required' using errcode='42501'; end if;
 elsif coalesce(nullif(current_setting('role',true),'none'),session_user) not in ('postgres','service_role','supabase_admin') then raise exception 'Backend role required' using errcode='42501';
 end if;
 select * into job from jyoti_notifications.invoice_whatsapp where invoice_id=p_invoice for update;
 if not found or job.state not in ('waiting_for_config','waiting_template') then return null; end if;
 select * into cfg from jyoti_notifications.whatsapp_settings where id;
 if not cfg.enabled then return null; end if;
 select decrypted_secret into token from vault.decrypted_secrets where name=cfg.token_secret_name;
 if token is null or length(token)<40 then return null; end if;
 ts:=floor(extract(epoch from clock_timestamp()))::bigint::text;
 payload:=jsonb_build_object('action','send','invoice_id',p_invoice::text,'timestamp',ts);
 sig:=encode(extensions.hmac(convert_to('send:'||p_invoice::text||':'||ts,'UTF8'),convert_to(token,'UTF8'),'sha256'),'hex');
 begin
 rid:=net.http_post(url:='https://jyoti-service.abhishek-767.workers.dev/api/whatsapp-invoice',
 headers:=jsonb_build_object('Content-Type','application/json','x-jyoti-signature',sig),
 body:=payload,timeout_milliseconds:=30000);
 update jyoti_notifications.invoice_whatsapp set state='submitted',request_id=rid,submitted_at=now(),template_name='jyoti_service_invoice_v1',error_code=null where invoice_id=p_invoice;
 exception when others then
 update jyoti_notifications.invoice_whatsapp set state='failed',error_code=sqlstate where invoice_id=p_invoice;
 return null;
 end;
 return rid;
end $function$
;

