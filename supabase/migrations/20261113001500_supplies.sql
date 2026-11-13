-- =============================================================================
-- HomeHub: supplies that run down with use
-- -----------------------------------------------------------------------------
-- A supply is a shopping item (Washing liquid) with a number of uses per
-- pack. It's linked to the tasks that use it (the "Do the washing" step,
-- the "Wash bedding" chore). Then, all in the database:
--
--   * ticking a linked task      -> one use less (unticking gives it back)
--   * reaching the threshold     -> suggested on the shopping list, once
--   * ticking it off as bought   -> one pack's uses more (or N packs when the
--                                   quantity is a plain number); unticking
--                                   takes them off again
--
-- It works from completions and list_entries triggers, so every way of
-- ticking (Today, offline replay, children) counts the same.
-- Supplies are left out of the buying-pattern suggestions so nothing is
-- suggested twice.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- STEP 1: tables
-- -----------------------------------------------------------------------------

-- 1a. One row per tracked product.
create table public.supplies (
  id                   uuid primary key default gen_random_uuid(),
  household_id         uuid not null references public.households (id) on delete cascade,
  item_id              uuid not null references public.items (id) on delete cascade,
  uses_per_pack        int not null check (uses_per_pack between 1 and 1000),
  uses_left            int not null default 0 check (uses_left between 0 and 100000),
  -- Suggest when this many uses (or fewer) are left.
  warn_at              int not null default 5 check (warn_at between 0 and 1000),
  -- uses_left when it was last suggested: stops it being suggested again
  -- after "Not now" (until it runs out). Cleared by a restock.
  suggested_at_uses    int,
  created_at           timestamptz not null default now(),
  unique (household_id, item_id)
);

-- 1b. Which tasks use which supply (both ways many-to-many).
create table public.supply_uses (
  supply_id    uuid not null references public.supplies (id) on delete cascade,
  household_id uuid not null references public.households (id) on delete cascade,
  kind         text not null check (kind in ('step', 'zone_task', 'chore')),
  task_id      uuid not null,
  created_at   timestamptz not null default now(),
  primary key (supply_id, kind, task_id)
);
create index supply_uses_task_idx on public.supply_uses (kind, task_id);

-- 1c. What each purchase added, so unticking "bought" takes off exactly that.
create table public.supply_restocks (
  list_entry_id uuid primary key references public.list_entries (id) on delete cascade,
  supply_id     uuid not null references public.supplies (id) on delete cascade,
  uses_added    int not null
);


-- -----------------------------------------------------------------------------
-- STEP 2: suggesting a supply that's running low
-- -----------------------------------------------------------------------------
-- Called after uses_left goes down. Adds a suggested line to the default
-- shopping list when:
--   * it's at or below the threshold,
--   * it isn't open on any list already, and
--   * it wasn't suggested yet at this level (once at the threshold, once more
--     when it runs out, in case the first was dismissed).
create or replace function public.supply_check(p_supply_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_supply public.supplies;
  v_name   text;
  v_list   uuid;
begin
  select * into v_supply from public.supplies where id = p_supply_id;
  if v_supply.id is null or v_supply.uses_left > v_supply.warn_at then
    return;
  end if;

  -- Step 2a: already suggested at this level?
  if v_supply.suggested_at_uses is not null
     and not (v_supply.uses_left = 0 and v_supply.suggested_at_uses > 0) then
    return;
  end if;

  -- Step 2b: remember we've looked at it at this level, even if it's already
  --          on a list (bought by hand counts too).
  update public.supplies set suggested_at_uses = v_supply.uses_left where id = p_supply_id;

  if exists (select 1 from public.list_entries e where e.item_id = v_supply.item_id and e.status = 'open') then
    return;
  end if;

  -- Step 2c: the list to add to (same choice as run_predictions).
  select l.id into v_list
  from public.lists l
  where l.household_id = v_supply.household_id and l.type = 'shopping'
  order by l.is_default desc, l.sort_order, l.created_at
  limit 1;
  if v_list is null then
    return;
  end if;

  select i.display_name into v_name from public.items i where i.id = v_supply.item_id;
  insert into public.list_entries (list_id, household_id, item_id, text, note, source, status)
  values (
    v_list, v_supply.household_id, v_supply.item_id, v_name,
    case when v_supply.uses_left = 0 then 'Run out'
         when v_supply.uses_left = 1 then 'About 1 use left'
         else 'About ' || v_supply.uses_left || ' uses left' end,
    'suggested', 'open'
  );
end;
$$;


-- -----------------------------------------------------------------------------
-- STEP 3: ticks use it up
-- -----------------------------------------------------------------------------

-- 3a. A tick: one use less of every supply the task uses.
create or replace function public.supplies_after_completion_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_supply_id uuid;
begin
  for v_supply_id in
    update public.supplies s
       set uses_left = greatest(0, s.uses_left - 1)
      from public.supply_uses u
     where u.supply_id = s.id and u.kind = new.kind and u.task_id = new.item_id
    returning s.id
  loop
    perform public.supply_check(v_supply_id);
  end loop;
  return null;
end;
$$;

create trigger completions_use_supplies
  after insert on public.completions
  for each row execute function public.supplies_after_completion_insert();

-- 3b. An untick: the use comes back. Not when the task itself was deleted
--     (its ticks are cleared then), and not for ticks from before the task
--     was linked to the supply.
create or replace function public.supplies_after_completion_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (select a.household_id from public.completion_assignee(old.kind, old.item_id) a) is null then
    return null;
  end if;
  update public.supplies s
     set uses_left = s.uses_left + 1
    from public.supply_uses u
   where u.supply_id = s.id and u.kind = old.kind and u.task_id = old.item_id
     and old.done_at >= u.created_at;
  return null;
end;
$$;

create trigger completions_return_supplies
  after delete on public.completions
  for each row execute function public.supplies_after_completion_delete();

-- 3c. A deleted task loses its supply links.
create or replace function public.delete_task_supply_uses()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.supply_uses u where u.kind = tg_argv[0] and u.task_id = old.id;
  return old;
end;
$$;

create trigger routine_steps_delete_supply_uses
  after delete on public.routine_steps
  for each row execute function public.delete_task_supply_uses('step');
create trigger zone_tasks_delete_supply_uses
  after delete on public.zone_tasks
  for each row execute function public.delete_task_supply_uses('zone_task');
create trigger chores_delete_supply_uses
  after delete on public.chores
  for each row execute function public.delete_task_supply_uses('chore');


-- -----------------------------------------------------------------------------
-- STEP 4: buying it tops it up
-- -----------------------------------------------------------------------------
-- Bought (open -> done) on a shopping list: add a pack's uses, or N packs when
-- the quantity is a plain number from 1 to 20. Unticked (done -> open): take
-- them off again. Restocking above the threshold allows the next suggestion.
create or replace function public.supplies_after_entry_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_supply  public.supplies;
  v_packs   int := 1;
  v_added   int;
begin
  if new.status is not distinct from old.status or new.item_id is null then
    return null;
  end if;

  -- Step 4a: bought.
  if new.status = 'done' and old.status = 'open' then
    select * into v_supply from public.supplies s where s.item_id = new.item_id;
    if v_supply.id is null then
      return null;
    end if;
    if coalesce(new.quantity, '') ~ '^\s*([1-9]|1[0-9]|20)\s*$' then
      v_packs := trim(new.quantity)::int;
    end if;
    v_added := v_packs * v_supply.uses_per_pack;

    update public.supplies
       set uses_left = least(100000, uses_left + v_added),
           suggested_at_uses = case when uses_left + v_added > warn_at then null else suggested_at_uses end
     where id = v_supply.id;
    insert into public.supply_restocks (list_entry_id, supply_id, uses_added)
    values (new.id, v_supply.id, v_added)
    on conflict (list_entry_id) do nothing;

  -- Step 4b: unticked: take that purchase off again.
  elsif old.status = 'done' and new.status = 'open' then
    with r as (
      delete from public.supply_restocks where list_entry_id = new.id
      returning supply_id, uses_added
    )
    update public.supplies s
       set uses_left = greatest(0, s.uses_left - r.uses_added)
      from r
     where s.id = r.supply_id;
  end if;
  return null;
end;
$$;

create trigger list_entries_restock_supplies
  after update on public.list_entries
  for each row execute function public.supplies_after_entry_update();


-- -----------------------------------------------------------------------------
-- STEP 5: no double suggestions from the buying-pattern engine
-- -----------------------------------------------------------------------------
-- Same as before (20261112000200 step 4a), plus: skip items tracked as supplies.
create or replace function public.run_predictions(p_household_id uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target_list uuid;
  v_added       int := 0;
  v_due         record;
begin
  -- Step 5a: pick the list to add to (default shopping list, else the first one).
  select l.id into v_target_list
  from public.lists l
  where l.household_id = p_household_id and l.type = 'shopping'
  order by l.is_default desc, l.sort_order, l.created_at
  limit 1;

  if v_target_list is null then
    return 0;
  end if;

  -- Step 5b: find items that are due and not already on any list.
  for v_due in
    select p.item_id, i.display_name
    from public.item_patterns p
    join public.items i on i.id = p.item_id
    where p.household_id = p_household_id
      and p.next_expected_at is not null
      and p.next_expected_at <= now()
      and p.confidence >= public.suggestion_min_confidence()
      -- Not already open on any list of this household.
      and not exists (
        select 1 from public.list_entries e
        where e.item_id = p.item_id and e.status = 'open'
      )
      -- Supplies are suggested by their uses instead.
      and not exists (select 1 from public.supplies s where s.item_id = p.item_id)
      -- Respect a recent "Not now": after a dismissal since the last purchase,
      -- wait at least a quarter of the usual gap (minimum 2 days).
      and not exists (
        select 1 from public.suggestion_feedback f
        where f.item_id = p.item_id
          and f.outcome = 'dismissed'
          and f.created_at > p.last_purchased_at
          and f.created_at > now() - make_interval(
                secs => (greatest(2, p.median_interval_days * 0.25) * 86400)::double precision)
      )
    order by p.next_expected_at
  loop
    -- Step 5c: add it as a suggested line.
    insert into public.list_entries (list_id, household_id, item_id, text, source, status)
    values (v_target_list, p_household_id, v_due.item_id, v_due.display_name, 'suggested', 'open');
    v_added := v_added + 1;
  end loop;

  return v_added;
end;
$$;


-- -----------------------------------------------------------------------------
-- STEP 5b: find or create a catalogue item by name (adults)
-- -----------------------------------------------------------------------------
-- The Supplies screen picks a product by name; it may never have been on a
-- list yet. Same matching as add_entry (normalize_item_name), so "Washing
-- liquids" finds "Washing liquid".
create or replace function public.ensure_item(p_name text, p_category text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_household_id uuid := public.current_household_id();
  v_text         text := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
  v_id           uuid;
begin
  if v_household_id is null then
    raise exception 'not_in_household';
  end if;
  if not public.is_household_adult() then
    raise exception 'adults_only';
  end if;
  if char_length(v_text) not between 1 and 200 then
    raise exception 'invalid_name';
  end if;

  insert into public.items (household_id, canonical_name, display_name, category)
  values (v_household_id, public.normalize_item_name(v_text), v_text, coalesce(nullif(btrim(p_category), ''), 'Other'))
  on conflict (household_id, canonical_name) do update
    set category = case
                     when public.items.category = 'Other' and excluded.category <> 'Other' then excluded.category
                     else public.items.category
                   end
  returning id into v_id;
  return v_id;
end;
$$;


-- -----------------------------------------------------------------------------
-- STEP 6: who can do what
-- -----------------------------------------------------------------------------
-- Everyone in the household reads (the task sheets show what a task uses);
-- adults set supplies up and correct the count. The triggers above change
-- counts for everyone's ticks.
-- 6a. Is this task (step / zone task / chore) in my household? For the
--     supply_uses policy, which runs as the signed-in user.
create or replace function public.task_in_my_household(p_kind text, p_task_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select a.household_id = public.current_household_id() from public.completion_assignee(p_kind, p_task_id) a limit 1),
    false
  );
$$;

alter table public.supplies enable row level security;
alter table public.supply_uses enable row level security;
alter table public.supply_restocks enable row level security; -- no policies: server only

create policy "supplies: household read" on public.supplies for select to authenticated
  using (household_id = public.current_household_id());
create policy "supplies: adults write" on public.supplies for all to authenticated
  using (household_id = public.current_household_id() and public.is_household_adult())
  with check (
    household_id = public.current_household_id() and public.is_household_adult()
    -- The product must be one of this household's items.
    and exists (select 1 from public.items i where i.id = item_id and i.household_id = public.current_household_id())
  );

create policy "supply_uses: household read" on public.supply_uses for select to authenticated
  using (household_id = public.current_household_id());
create policy "supply_uses: adults write" on public.supply_uses for all to authenticated
  using (household_id = public.current_household_id() and public.is_household_adult())
  with check (
    household_id = public.current_household_id() and public.is_household_adult()
    and exists (select 1 from public.supplies s where s.id = supply_id and s.household_id = public.current_household_id())
    and public.task_in_my_household(kind, task_id)
  );

revoke execute on function
  public.supply_check(uuid),
  public.supplies_after_completion_insert(),
  public.supplies_after_completion_delete(),
  public.delete_task_supply_uses(),
  public.supplies_after_entry_update(),
  public.task_in_my_household(text, uuid),
  public.ensure_item(text, text)
from public, anon, authenticated;
grant execute on function public.task_in_my_household(text, uuid), public.ensure_item(text, text) to authenticated;

alter publication supabase_realtime add table public.supplies;
