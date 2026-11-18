alter policy tickets_create on public.service_tickets with check (
  created_by = (select auth.uid()) and (
    ((select jyoti_private.staff_role()) = 'manager' and customer_id is null)
    or (customer_id = (select auth.uid()) and '91' || mobile = (select ltrim(auth.jwt() ->> 'phone', '+')))
  )
);
revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
