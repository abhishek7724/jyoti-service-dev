alter table public.staff
 add column username text check(length(username) between 1 and 254),
 add column mobile_number text check(mobile_number ~ '^[6-9][0-9]{9}$');
update public.staff s set username=case when lower(u.email) like '%@staff.jyoti.invalid' then split_part(lower(u.email),'@',1) else lower(u.email) end
from auth.users u where u.id=s.user_id and u.email is not null;
create unique index staff_username_unique on public.staff(lower(username)) where username is not null;

create function public.update_staff_profile(p_actor uuid,p_user uuid,p_name text,p_mobile text,p_role text)
returns void language plpgsql set search_path='' as $$
declare target public.staff%rowtype;
begin
 perform 1 from public.staff where role='manager' and active order by user_id for update;
 if not exists(select 1 from public.staff where user_id=p_actor and role='manager' and active)then raise exception 'Only managers can manage staff';end if;
 select * into strict target from public.staff where user_id=p_user for update;
 if p_role not in ('manager','technician','billing') or p_role is null then raise exception 'Choose Technician, Manager or Billing';end if;
 if target.role='manager' and target.active and p_role<>'manager' and not exists(select 1 from public.staff where role='manager' and active and user_id<>p_user)then raise exception 'Keep at least one active manager';end if;
 if target.role='technician' and p_role<>'technician' and exists(select 1 from public.service_tickets where assigned_to=p_user and status not in ('Repair Complete','Paid, not billed','Billed','Paid'))then raise exception 'Reassign or complete this technician''s open tickets before changing their role';end if;
 update public.staff set name=p_name,mobile_number=p_mobile,role=p_role where user_id=p_user;
end $$;
revoke all on function public.update_staff_profile(uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.update_staff_profile(uuid,uuid,text,text,text) to service_role;
