
alter table jyoti_notifications.invoice_whatsapp drop constraint invoice_whatsapp_state_check;
alter table jyoti_notifications.invoice_whatsapp add constraint invoice_whatsapp_state_check check(state in ('waiting_for_config','submitted','processing','waiting_template','accepted','failed','unknown'));
alter table jyoti_notifications.invoice_whatsapp add column media_id text;
alter table jyoti_notifications.invoice_whatsapp add column template_name text not null default 'hello_world';
create function public.jyoti_whatsapp_config()
returns jsonb language plpgsql security definer set search_path='' as $fn$
begin
 if coalesce(current_setting('role',true),'') not in ('service_role','postgres') then raise exception 'Server only' using errcode='42501'; end if;
 return (select jsonb_build_object('enabled',s.enabled,'test_recipient',s.test_recipient,'token',v.decrypted_secret)
 from jyoti_notifications.whatsapp_settings s left join vault.decrypted_secrets v on v.name=s.token_secret_name where s.id);
end $fn$;
revoke all on function public.jyoti_whatsapp_config() from public,anon,authenticated;
grant execute on function public.jyoti_whatsapp_config() to service_role;
create function public.jyoti_whatsapp_claim(p_invoice uuid)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare claimed uuid;
begin
 if coalesce(current_setting('role',true),'') not in ('service_role','postgres') then raise exception 'Server only' using errcode='42501'; end if;
 if not exists(select 1 from jyoti_notifications.whatsapp_settings where id and enabled) then return null; end if;
 update jyoti_notifications.invoice_whatsapp set state='processing',template_name='jyoti_service_invoice_v1'
 where invoice_id=p_invoice and state in ('submitted','waiting_template','waiting_for_config') returning invoice_id into claimed;
 if claimed is null then return null; end if;
 return (select to_jsonb(i) from public.invoices i where id=claimed);
end $fn$;
revoke all on function public.jyoti_whatsapp_claim(uuid) from public,anon,authenticated;
grant execute on function public.jyoti_whatsapp_claim(uuid) to service_role;
create function public.jyoti_whatsapp_finish(p_invoice uuid,p_state text,p_message text,p_media text,p_error text)
returns void language plpgsql security definer set search_path='' as $fn$
begin
 if coalesce(current_setting('role',true),'') not in ('service_role','postgres') then raise exception 'Server only' using errcode='42501'; end if;
 if p_state not in ('accepted','failed','unknown') then raise exception 'Invalid state'; end if;
 update jyoti_notifications.invoice_whatsapp set state=p_state,message_id=p_message,media_id=p_media,error_code=left(p_error,100),http_status=case when p_state='accepted' then 200 else null end where invoice_id=p_invoice and state='processing';
end $fn$;
revoke all on function public.jyoti_whatsapp_finish(uuid,text,text,text,text) from public,anon,authenticated;
grant execute on function public.jyoti_whatsapp_finish(uuid,text,text,text,text) to service_role;
create function public.jyoti_whatsapp_wait_for_template(p_invoice uuid)
returns void language plpgsql security definer set search_path='' as $fn$
begin
 if coalesce(current_setting('role',true),'') not in ('service_role','postgres') then raise exception 'Server only' using errcode='42501'; end if;
 update jyoti_notifications.invoice_whatsapp set state='waiting_template',template_name='jyoti_service_invoice_v1' where invoice_id=p_invoice and state in ('submitted','waiting_for_config','waiting_template');
end $fn$;
revoke all on function public.jyoti_whatsapp_wait_for_template(uuid) from public,anon,authenticated;
grant execute on function public.jyoti_whatsapp_wait_for_template(uuid) to service_role;
