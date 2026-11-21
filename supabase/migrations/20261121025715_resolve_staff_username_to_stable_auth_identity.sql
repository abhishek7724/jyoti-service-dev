-- Resolve editable login names independently of stable Supabase auth identities.
create function public.staff_login_identity(p_username text) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('user_id',u.id,'email',u.email)
 from public.staff s join auth.users u on u.id=s.user_id
 where s.active and s.username=lower(trim(p_username))
 limit 1;
$$;
revoke all on function public.staff_login_identity(text) from public,anon,authenticated;
grant execute on function public.staff_login_identity(text) to service_role;
