create or replace function jyoti_private.check_parts_review() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'Repair Complete' and old.status is distinct from new.status and
    (not new.parts_reviewed or not exists (
      select 1 from public.ticket_parts where ticket_id = new.id
    )) then
    raise exception 'Add at least one item in Parts used before completing the repair';
  end if;
  return new;
end
$$;
revoke all on function jyoti_private.check_parts_review() from public, anon, authenticated;
