-- =============================================================================
-- HomeHub: weekly review
-- -----------------------------------------------------------------------------
-- What got done in a week, per person: routine steps, chores and zone tasks
-- they ticked (completions.done_by), to-dos they ticked (list_entries
-- completed_by), plus how many shopping lines were bought. Next week's preview
-- (events, holidays, bins, chores, zone) is worked out in the app from data it
-- already has. Days are the household's own (its time zone), not UTC.
--
-- Also: the Sunday-evening notification preference.
-- =============================================================================

-- STEP 1: counts for one household and date range (server and wrapper use it)
create or replace function public.week_counts(p_household_id uuid, p_from date, p_to date)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with people as (
    select m.id, m.user_id from public.members m where m.household_id = p_household_id
  ),
  ticks as (
    select c.done_by as member_id, c.kind, count(*) as n
    from public.completions c
    where c.household_id = p_household_id
      and c.done_at >= (p_from::timestamp at time zone (select h.timezone from public.households h where h.id = p_household_id)) and c.done_at < ((p_to + 1)::timestamp at time zone (select h.timezone from public.households h where h.id = p_household_id))
      and c.done_by is not null
    group by c.done_by, c.kind
  ),
  todos as (
    select p.id as member_id, count(*) as n
    from public.list_entries e
    join public.lists l on l.id = e.list_id and l.type = 'todo'
    join people p on p.user_id = e.completed_by
    where e.household_id = p_household_id
      and e.status in ('done', 'cleared')
      and e.completed_at >= (p_from::timestamp at time zone (select h.timezone from public.households h where h.id = p_household_id)) and e.completed_at < ((p_to + 1)::timestamp at time zone (select h.timezone from public.households h where h.id = p_household_id))
    group by p.id
  )
  select jsonb_build_object(
    'people', coalesce((
      select jsonb_agg(jsonb_build_object(
        'member_id', p.id,
        'steps',      coalesce((select n from ticks t where t.member_id = p.id and t.kind = 'step'), 0),
        'chores',     coalesce((select n from ticks t where t.member_id = p.id and t.kind = 'chore'), 0),
        'zone_tasks', coalesce((select n from ticks t where t.member_id = p.id and t.kind = 'zone_task'), 0),
        'todos',      coalesce((select n from todos t where t.member_id = p.id), 0)
      ))
      from people p
    ), '[]'::jsonb),
    'shopping_bought', (
      select count(*)
      from public.list_entries e
      join public.lists l on l.id = e.list_id and l.type = 'shopping'
      where e.household_id = p_household_id
        and e.status in ('done', 'cleared')
        and e.completed_at >= (p_from::timestamp at time zone (select h.timezone from public.households h where h.id = p_household_id)) and e.completed_at < ((p_to + 1)::timestamp at time zone (select h.timezone from public.households h where h.id = p_household_id))
    )
  );
$$;

-- STEP 2: the browser's version: the caller's own household, adults only
create or replace function public.weekly_review(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_household_adult() then
    raise exception 'adults_only';
  end if;
  if p_to < p_from or p_to - p_from > 31 then
    raise exception 'invalid_range';
  end if;
  return public.week_counts(public.current_household_id(), p_from, p_to);
end;
$$;

-- STEP 3: the Sunday-evening notification (adults by default)
alter table public.notification_prefs
  add column weekly_review boolean not null default true;

-- STEP 4: permissions
revoke execute on function
  public.week_counts(uuid, date, date),
  public.weekly_review(date, date)
from public, anon, authenticated;

grant execute on function public.weekly_review(date, date) to authenticated;
grant execute on function public.week_counts(uuid, date, date) to service_role;
