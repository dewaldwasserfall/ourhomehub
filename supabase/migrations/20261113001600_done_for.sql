-- =============================================================================
-- HomeHub: credit the person a task was done FOR, not who ticked it
-- -----------------------------------------------------------------------------
-- The kids do their chores, but mum or dad tick them off. Until now stars and
-- the week review counted completions.done_by (who tapped), so a parent
-- ticking Shannon's chore earned the parent the star.
--
--   * completions.done_for: the task's assignee (a routine step falls back to
--     the routine's owner); unassigned tasks count for whoever ticked.
--     Filled in by a trigger, so every way of ticking agrees.
--   * member_stars and week_counts now count by done_for, and to-dos by who
--     they're assigned to.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- STEP 1: the column, filled for new ticks and old ones
-- -----------------------------------------------------------------------------
alter table public.completions
  add column done_for uuid references public.members (id) on delete set null;
create index completions_done_for_idx on public.completions (done_for);

-- 1a. New ticks: the assignee, else whoever ticked.
create or replace function public.completions_fill_done_for()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.done_for := coalesce(
    (select a.assignee from public.completion_assignee(new.kind, new.item_id) a limit 1),
    new.done_by
  );
  return new;
end;
$$;

create trigger completions_fill_done_for
  before insert on public.completions
  for each row execute function public.completions_fill_done_for();

-- 1b. Existing ticks: same rule, using today's assignments.
update public.completions c
   set done_for = coalesce(
     (select a.assignee from public.completion_assignee(c.kind, c.item_id) a limit 1),
     c.done_by
   );


-- -----------------------------------------------------------------------------
-- STEP 2: stars count what was done for the child
-- -----------------------------------------------------------------------------
-- Same as 20261113001300 step 2b, but counting done_for, and to-dos assigned
-- to them whoever ticked them (bought/cleared lines still count).
create or replace function public.member_stars(p_member_id uuid, p_today date)
returns table (earned int, spent int, balance int, streak int)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_earned int;
  v_spent  int;
begin
  -- Step 2-1: same household, and children only see their own.
  if not exists (
    select 1 from public.members m
    where m.id = p_member_id and m.household_id = public.current_household_id()
  ) then
    raise exception 'member_not_in_household';
  end if;
  if not public.is_household_adult() and p_member_id is distinct from public.current_member_id() then
    raise exception 'not_assigned_to_you';
  end if;

  -- Step 2-2: count.
  select
    (select count(*) from public.completions c where c.done_for = p_member_id)
    + (select count(*) from public.list_entries e
       where e.assigned_to = p_member_id and e.status in ('done', 'cleared'))
  into v_earned;

  select coalesce(sum(r.stars_needed), 0) into v_spent
  from public.rewards r where r.member_id = p_member_id and r.given_at is not null;

  return query select v_earned, v_spent, v_earned - v_spent, public.member_streak(p_member_id, p_today);
end;
$$;


-- -----------------------------------------------------------------------------
-- STEP 3: the week review counts the same way
-- -----------------------------------------------------------------------------
-- Same as 20261113001400 step 1, with ticks by done_for and to-dos by their
-- assignee (else whoever ticked).
create or replace function public.week_counts(p_household_id uuid, p_from date, p_to date)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with bounds as (
    select (p_from::timestamp at time zone h.timezone) as t_from,
           ((p_to + 1)::timestamp at time zone h.timezone) as t_to
    from public.households h where h.id = p_household_id
  ),
  people as (
    select m.id, m.user_id from public.members m where m.household_id = p_household_id
  ),
  ticks as (
    select c.done_for as member_id, c.kind, count(*) as n
    from public.completions c, bounds b
    where c.household_id = p_household_id
      and c.done_at >= b.t_from and c.done_at < b.t_to
      and c.done_for is not null
    group by c.done_for, c.kind
  ),
  todos as (
    select coalesce(e.assigned_to, p.id) as member_id, count(*) as n
    from public.list_entries e
    join public.lists l on l.id = e.list_id and l.type = 'todo'
    left join people p on p.user_id = e.completed_by
    cross join bounds b
    where e.household_id = p_household_id
      and e.status in ('done', 'cleared')
      and e.completed_at >= b.t_from and e.completed_at < b.t_to
    group by 1
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
      cross join bounds b
      where e.household_id = p_household_id
        and e.status in ('done', 'cleared')
        and e.completed_at >= b.t_from and e.completed_at < b.t_to
    )
  );
$$;

revoke execute on function public.completions_fill_done_for() from public, anon, authenticated;
