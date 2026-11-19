begin;
set local role service_role;
do $$
declare manager uuid; tech uuid;
begin
 select user_id into manager from public.staff where role='manager' and active order by user_id limit 1;
 select user_id into tech from public.staff where role='technician' and active order by user_id limit 1;
 perform public.update_staff_profile(manager,manager,'Manager fixture','9000000000','manager');
 if not exists(select 1 from public.staff where user_id=manager and mobile_number='9000000000')then raise exception 'Staff mobile not saved';end if;
 begin
  perform public.update_staff_profile(tech,manager,'Manager fixture','9000000000','billing');
  raise exception 'Regression: technician managed staff';
 exception when raise_exception then if sqlerrm<>'Only managers can manage staff' then raise;end if;end;
 if (select count(*) from public.staff where role='manager' and active)=1 then
  begin
   perform public.update_staff_profile(manager,manager,'Manager fixture','9000000000','billing');
   raise exception 'Regression: last manager removed';
  exception when raise_exception then if sqlerrm<>'Keep at least one active manager' then raise;end if;end;
 end if;
 if has_function_privilege('authenticated','public.update_staff_profile(uuid,uuid,text,text,text)','execute')then raise exception 'Staff RPC exposed directly';end if;
end $$;
rollback;
