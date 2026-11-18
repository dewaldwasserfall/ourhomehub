-- =============================================================================
-- HomeHub: reward types and each child's wallet
-- -----------------------------------------------------------------------------
-- 1. Reward types (reward_plans.reward_type / value_amount / value_per):
--      time     minutes of game/screen time
--      cash     euros
--      one_off  a thing or an outing (no amount; earned, then given)
--    Time and cash rewards have a value, earned either per star
--    (value_per = 'star', e.g. 5 minutes for every star) or when the
--    reward's goal is reached and a parent taps Give (value_per = 'goal').
--
-- 2. The wallet (wallet_entries): one line per change to a child's balance,
--    in minutes or euros. The balance is the sum, so every number can be
--    traced back:
--      earned_star  +  a confirmed star on a per-star reward (automatic)
--      earned_goal  +  a goal reached and given
--      used         -  game time used (any adult)
--      paid         -  money paid out (any adult)
--      adjust       ±  a correction or bonus, with a note (any adult)
--
-- 3. Earning is automatic: when a tick that counts for a per-star reward is
--    confirmed (or a parent fills it in), its value goes in; if the tick is
--    later undone or sent back, it comes out again (triggers below).
--
-- 4. Lennon's and Shannon's current rewards become Time (5 minutes a star)
--    and Cash (€0.20 a star); their wallets are worked out from past stars,
--    minus what was already given or paid out before wallets existed.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- STEP 1: reward types
-- -----------------------------------------------------------------------------
alter table public.reward_plans
  add column reward_type  text not null default 'one_off' check (reward_type in ('time', 'cash', 'one_off')),
  add column value_amount numeric(10, 2) check (value_amount > 0 and value_amount <= 100000),
  add column value_per    text check (value_per in ('star', 'goal'));

alter table public.reward_plans
  add constraint reward_plans_value_shape check (
    (reward_type = 'one_off' and value_amount is null and value_per is null)
    or (reward_type in ('time', 'cash') and value_amount is not null and value_per is not null)
  );

comment on column public.reward_plans.reward_type is 'time (minutes), cash (euros) or one_off (a thing; no amount).';
comment on column public.reward_plans.value_amount is 'Time/cash: minutes or euros earned, per star or per goal reached.';
comment on column public.reward_plans.value_per is 'Time/cash: star (each confirmed star) or goal (when the reward is given).';


-- -----------------------------------------------------------------------------
-- STEP 2: the wallet
-- -----------------------------------------------------------------------------
create table public.wallet_entries (
  id             uuid primary key default gen_random_uuid(),
  household_id   uuid not null references public.households (id) on delete cascade,
  member_id      uuid not null references public.members (id) on delete cascade,
  unit           text not null check (unit in ('minutes', 'euros')),
  amount         numeric(10, 2) not null check (amount <> 0),
  kind           text not null check (kind in ('earned_star', 'earned_goal', 'used', 'paid', 'adjust')),
  plan_id        uuid references public.reward_plans (id) on delete set null,
  completion_id  uuid references public.completions (id) on delete set null,
  entry_id       uuid references public.list_entries (id) on delete set null,
  period_id      uuid references public.reward_periods (id) on delete set null,
  note           text check (char_length(note) <= 200),
  created_by     uuid references public.members (id) on delete set null,
  created_at     timestamptz not null default now(),
  -- A star earns once per reward.
  unique (plan_id, completion_id),
  unique (plan_id, entry_id)
);
create index wallet_entries_member_idx on public.wallet_entries (member_id, created_at desc);

alter table public.wallet_entries enable row level security;
-- Everyone in the household can read (a child sees their own balance);
-- changes only through the functions below.
create policy "wallet_entries: household read" on public.wallet_entries for select to authenticated
  using (household_id = public.current_household_id());
alter publication supabase_realtime add table public.wallet_entries;

-- 2a. The unit a reward pays in.
create or replace function public.reward_unit(p_type text)
returns text
language sql
immutable
as $$
  select case p_type when 'time' then 'minutes' when 'cash' then 'euros' end;
$$;


-- -----------------------------------------------------------------------------
-- STEP 3: earning automatically from stars
-- -----------------------------------------------------------------------------

-- 3a. Routine steps, chores, zone tasks: earn when confirmed; un-earn when
--     the tick is undone, sent back, or goes back to waiting.
create or replace function public.wallet_on_completion()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Step 3a-1: no longer a confirmed star? Take its value back out.
  --            (Deletes run BEFORE the row goes: afterwards the foreign key
  --            has already cleared completion_id on the wallet line.)
  if tg_op = 'DELETE' then
    delete from public.wallet_entries where completion_id = old.id and kind = 'earned_star';
    return old;
  end if;
  if tg_op = 'UPDATE' and new.pending and not old.pending then
    delete from public.wallet_entries where completion_id = new.id and kind = 'earned_star';
    return null;
  end if;

  -- Step 3a-2: a confirmed star: add its value for each per-star reward of
  --            this child that it counts for (once per reward).
  if new.pending or new.done_for is null then
    return null;
  end if;
  insert into public.wallet_entries (household_id, member_id, unit, amount, kind, plan_id, completion_id, created_at)
  select p.household_id, p.member_id, public.reward_unit(p.reward_type), p.value_amount, 'earned_star', p.id, new.id, new.done_at
  from public.reward_plans p
  join public.households h on h.id = p.household_id
  where p.member_id = new.done_for and p.active
    and p.reward_type in ('time', 'cash') and p.value_per = 'star'
    and new.done_at >= (p.counts_from::timestamp at time zone h.timezone)
    and (p.counts = 'all' or exists (
      select 1 from public.reward_plan_tasks t where t.plan_id = p.id and t.kind = new.kind and t.task_id = new.item_id))
  on conflict (plan_id, completion_id) do nothing;
  return null;
end;
$$;

create trigger completions_wallet
  after insert or update of pending, done_for on public.completions
  for each row execute function public.wallet_on_completion();
create trigger completions_wallet_delete
  before delete on public.completions
  for each row execute function public.wallet_on_completion();

-- 3b. To-dos (only for rewards that count everything): earn when done and
--     confirmed; un-earn when reopened, sent back or deleted. ('cleared' is
--     a done to-do tidied away: it keeps its value.)
create or replace function public.wallet_on_entry()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_child uuid;
begin
  if tg_op = 'DELETE' then
    delete from public.wallet_entries where entry_id = old.id and kind = 'earned_star';
    return old; -- runs BEFORE delete (see 3a)
  end if;
  if new.status = 'open' or new.pending then
    delete from public.wallet_entries where entry_id = new.id and kind = 'earned_star';
    return null;
  end if;

  v_child := coalesce(new.done_for, new.assigned_to);
  if v_child is null or not exists (select 1 from public.lists l where l.id = new.list_id and l.type = 'todo') then
    return null;
  end if;
  insert into public.wallet_entries (household_id, member_id, unit, amount, kind, plan_id, entry_id, created_at)
  select p.household_id, p.member_id, public.reward_unit(p.reward_type), p.value_amount, 'earned_star', p.id, new.id, coalesce(new.completed_at, now())
  from public.reward_plans p
  join public.households h on h.id = p.household_id
  where p.member_id = v_child and p.active and p.counts = 'all'
    and p.reward_type in ('time', 'cash') and p.value_per = 'star'
    and coalesce(new.completed_at, now()) >= (p.counts_from::timestamp at time zone h.timezone)
  on conflict (plan_id, entry_id) do nothing;
  return null;
end;
$$;

create trigger list_entries_wallet
  after insert or update of status, pending, done_for on public.list_entries
  for each row execute function public.wallet_on_entry();
create trigger list_entries_wallet_delete
  before delete on public.list_entries
  for each row execute function public.wallet_on_entry();


-- -----------------------------------------------------------------------------
-- STEP 4: earning when a goal is given (give_reward, as before, plus this)
-- -----------------------------------------------------------------------------
create or replace function public.give_reward(p_plan_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plan  public.reward_plans;
  v_today date;
  v_row   record;
  v_cost  int;
  v_id    uuid;
begin
  -- Step 4a: parents only; the plan must be in this household.
  if not public.is_parent() then
    raise exception 'parents_only';
  end if;
  select * into v_plan from public.reward_plans p where p.id = p_plan_id and p.household_id = public.current_household_id();
  if v_plan.id is null then
    raise exception 'plan_not_found';
  end if;

  -- Step 4b: earned, and not given yet this period?
  select (now() at time zone h.timezone)::date into v_today from public.households h where h.id = v_plan.household_id;
  select * into v_row from public.reward_progress_core(v_plan.member_id, v_today) r where r.plan_id = p_plan_id;
  if v_row.plan_id is null or v_row.given then
    raise exception 'already_given';
  end if;
  if v_row.target is null or v_row.target = 0 or v_row.progress < v_row.target then
    raise exception 'not_earned_yet';
  end if;

  -- Step 4c: record it, with what earned it.
  v_cost := case when v_plan.goal = 'stars' and (v_plan.carry_over or v_plan.period = 'once') then v_row.target else 0 end;
  insert into public.reward_periods (plan_id, household_id, period_start, given_by, stars_used)
  values (p_plan_id, v_plan.household_id, v_row.period_start, public.current_member_id(), v_cost)
  returning id into v_id;
  update public.reward_periods
     set ticks = public.reward_snapshot(p_plan_id, v_row.period_start, now(), coalesce(nullif(v_cost, 0), v_row.target), v_id)
   where id = v_id;

  -- Step 4d: a time/cash reward paid per goal: its value goes in the wallet.
  if v_plan.reward_type in ('time', 'cash') and v_plan.value_per = 'goal' then
    insert into public.wallet_entries (household_id, member_id, unit, amount, kind, plan_id, period_id, created_by)
    values (v_plan.household_id, v_plan.member_id, public.reward_unit(v_plan.reward_type), v_plan.value_amount, 'earned_goal', p_plan_id, v_id, public.current_member_id());
  end if;

  if v_plan.period = 'once' then
    update public.reward_plans set active = false where id = p_plan_id;
  end if;
end;
$$;


-- -----------------------------------------------------------------------------
-- STEP 5: using time, paying out, adjusting (any adult)
-- -----------------------------------------------------------------------------
-- p_kind: 'used' (minutes) or 'paid' (euros): p_amount is how much, > 0,
-- and can't take the balance below zero. 'adjust': p_amount is signed.
-- Returns the new balance.
create or replace function public.wallet_change(p_member_id uuid, p_unit text, p_kind text, p_amount numeric, p_note text)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_household_id uuid := public.current_household_id();
  v_balance      numeric;
  v_amount       numeric;
begin
  -- Step 5a: adults only; a child of this household; a sensible change.
  if not public.is_household_adult() then
    raise exception 'adults_only';
  end if;
  if not exists (select 1 from public.members m where m.id = p_member_id and m.household_id = v_household_id and m.role = 'child') then
    raise exception 'member_not_in_household';
  end if;
  if p_unit not in ('minutes', 'euros') or p_kind not in ('used', 'paid', 'adjust') then
    raise exception 'invalid_change';
  end if;
  if (p_kind = 'used' and p_unit <> 'minutes') or (p_kind = 'paid' and p_unit <> 'euros') then
    raise exception 'invalid_change';
  end if;
  if p_amount is null or p_amount = 0 or abs(p_amount) > 100000 or (p_kind <> 'adjust' and p_amount < 0) then
    raise exception 'invalid_amount';
  end if;

  -- Step 5b: not more than there is.
  select coalesce(sum(w.amount), 0) into v_balance from public.wallet_entries w where w.member_id = p_member_id and w.unit = p_unit;
  v_amount := case when p_kind = 'adjust' then p_amount else -p_amount end;
  if p_kind <> 'adjust' and v_balance + v_amount < 0 then
    raise exception 'not_enough';
  end if;

  -- Step 5c: write it down.
  insert into public.wallet_entries (household_id, member_id, unit, amount, kind, note, created_by)
  values (v_household_id, p_member_id, p_unit, round(v_amount, 2), p_kind, nullif(trim(p_note), ''), public.current_member_id());
  return v_balance + v_amount;
end;
$$;

-- 5d. The same from an unlocked board (as the parent who unlocked it).
create or replace function public.board_wallet_change(p_member_id uuid, p_unit text, p_kind text, p_amount numeric, p_note text)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev    text;
  v_balance numeric;
begin
  v_prev := public.board_act_as(public.board_admin_member());
  v_balance := public.wallet_change(p_member_id, p_unit, p_kind, p_amount, p_note);
  perform set_config('request.jwt.claim.sub', v_prev, true);
  return v_balance;
end;
$$;


-- 5e. Give a reward from an unlocked board (e.g. a one-off: "Disneyland").
create or replace function public.board_give_reward(p_plan_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev text;
begin
  v_prev := public.board_act_as(public.board_admin_member());
  perform public.give_reward(p_plan_id);
  perform set_config('request.jwt.claim.sub', v_prev, true);
end;
$$;


-- -----------------------------------------------------------------------------
-- STEP 6: the current rewards become Time and Cash
-- -----------------------------------------------------------------------------
-- Both are "for every star": the value is per star, so leftover stars no
-- longer need to carry over (the wallet does that); the daily/weekly bar now
-- shows just that day's / week's stars.
update public.reward_plans
   set reward_type = 'time', value_amount = 5, value_per = 'star', carry_over = false
 where active and reward_type = 'one_off' and title = '5min extra screentime for every star';

update public.reward_plans
   set reward_type = 'cash', value_amount = 0.20, value_per = 'star', carry_over = false
 where active and reward_type = 'one_off' and title = '€0.20 for every completed task';


-- -----------------------------------------------------------------------------
-- STEP 7: wallets worked out from past stars
-- -----------------------------------------------------------------------------
-- 7a. Every confirmed star since each per-star reward began.
insert into public.wallet_entries (household_id, member_id, unit, amount, kind, plan_id, completion_id, entry_id, created_at)
select p.household_id, p.member_id, public.reward_unit(p.reward_type), p.value_amount, 'earned_star', p.id,
       case when t.kind <> 'todo' then t.id end,
       case when t.kind = 'todo' then t.id end,
       t.done_at
from public.reward_plans p
join public.households h on h.id = p.household_id
cross join lateral public.reward_plan_ticks(p.id, p.counts_from::timestamp at time zone h.timezone, now()) t
where p.active and p.reward_type in ('time', 'cash') and p.value_per = 'star'
on conflict do nothing;

-- 7b. Minus what was already given or paid out for them before wallets
--     (each star used then is worth its value now). Time counts as used;
--     cash as paid.
insert into public.wallet_entries (household_id, member_id, unit, amount, kind, plan_id, period_id, note, created_at)
select p.household_id, p.member_id, public.reward_unit(p.reward_type),
       -(p.value_amount * n.stars),
       case p.reward_type when 'time' then 'used' else 'paid' end,
       p.id, n.period_id,
       'Given before wallets started', n.at
from public.reward_plans p
cross join lateral (
  select r.id as period_id, r.given_at as at,
         (select count(*) from jsonb_array_elements(r.ticks) x where x ? 'id') as stars
  from public.reward_periods r where r.plan_id = p.id
  union all
  select null, r.paid_at,
         (select count(*) from jsonb_array_elements(r.ticks) x where x ? 'id')
  from public.reward_payouts r where r.plan_id = p.id
) n
where p.active and p.reward_type in ('time', 'cash') and p.value_per = 'star' and n.stars > 0;


-- -----------------------------------------------------------------------------
-- STEP 8: permissions
-- -----------------------------------------------------------------------------
revoke execute on function
  public.wallet_on_completion(),
  public.wallet_on_entry(),
  public.wallet_change(uuid, text, text, numeric, text),
  public.board_wallet_change(uuid, text, text, numeric, text),
  public.board_give_reward(uuid)
from public, anon, authenticated;

grant execute on function
  public.wallet_change(uuid, text, text, numeric, text),
  public.board_wallet_change(uuid, text, text, numeric, text),
  public.board_give_reward(uuid)
to authenticated;
