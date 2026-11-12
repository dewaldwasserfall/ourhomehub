-- =============================================================================
-- Household Hub: triggers, prediction engine and RPCs (V1)
-- -----------------------------------------------------------------------------
-- What this migration creates:
--   1. Item name normalisation ("Coffee Beans " == "coffee bean")
--   2. Triggers that keep list entries consistent and turn ticks into purchases
--   3. The pattern calculator (how often is each item bought?)
--   4. The suggestion engine (is it time to put it back on the list?)
--   5. RPCs the app calls: create/join household, add entry, refresh
--   6. Function permissions
--
-- How the learning works, in one paragraph:
--   Ticking off a shopping line records a purchase. Purchases on the same day
--   collapse into one "shopping day". Once an item has 3+ shopping days, the
--   engine takes the median gap between them as the item's rhythm. When
--   (median gap x threshold_factor) has passed since the last purchase, and
--   the rhythm is regular enough, the item is added to the default shopping
--   list as a suggestion. "Not now" on a suggestion makes the item wait
--   longer next time; buying it before it was suggested makes it come sooner.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- STEP 1: Item name normalisation
-- -----------------------------------------------------------------------------
-- Lowercases, trims, collapses whitespace and singularises the last word with
-- a few English rules. Deliberately conservative: a wrong merge ("chips" and
-- "chip") is harmless, a missed merge just splits history in two.
create or replace function public.normalize_item_name(p_name text)
returns text
language plpgsql
immutable
as $$
declare
  v_name text;
begin
  -- Step 1a: lowercase, trim, collapse internal whitespace.
  v_name := lower(regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g'));

  -- Step 1b: singularise the last word.
  if v_name ~ '(^| )(cookies|movies|smoothies|brownies|veggies|pies|ties)$' then
    -- Words where "ies" -> "y" would be wrong: just drop the "s".
    v_name := left(v_name, -1);
  elsif v_name ~ '[^aeiou]ies$' and length(v_name) > 4 then
    -- berries -> berry, batteries -> battery
    v_name := regexp_replace(v_name, 'ies$', 'y');
  elsif v_name ~ '(ch|sh|x|ss|z)es$' then
    -- sandwiches -> sandwich, boxes -> box, glasses -> glass
    v_name := regexp_replace(v_name, 'es$', '');
  elsif v_name ~ '[^aeiouh]oes$' then
    -- tomatoes -> tomato, potatoes -> potato
    v_name := regexp_replace(v_name, 'es$', '');
  elsif v_name ~ '[^sui]s$' and length(v_name) > 3 then
    -- eggs -> egg, apples -> apple (but not hummus, kiwis, glass)
    v_name := left(v_name, -1);
  end if;

  return v_name;
end;
$$;


-- -----------------------------------------------------------------------------
-- STEP 2: List entry triggers
-- -----------------------------------------------------------------------------

-- 2a. Before insert: copy household_id from the list, stamp the author, tidy text.
--     Runs as the caller, so the list lookup respects RLS: a list from another
--     household is invisible, household_id stays null and the insert fails.
create or replace function public.list_entries_before_insert()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  select l.household_id into new.household_id
  from public.lists l
  where l.id = new.list_id;

  new.added_by := coalesce(new.added_by, auth.uid());
  new.text := btrim(new.text);
  new.quantity := nullif(btrim(coalesce(new.quantity, '')), '');

  if new.status = 'done' then
    new.completed_at := coalesce(new.completed_at, now());
  end if;

  return new;
end;
$$;

create trigger list_entries_before_insert
  before insert on public.list_entries
  for each row execute function public.list_entries_before_insert();

-- 2b. Before update: maintain timestamps and stop rows moving between households.
create or replace function public.list_entries_before_update()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- Step 2b-1: rows never change household or list after creation.
  new.household_id := old.household_id;
  new.list_id := old.list_id;
  new.updated_at := now();

  -- Step 2b-2: stamp who ticked it off and when; clear it when unticked.
  if new.status is distinct from old.status then
    if new.status = 'done' then
      new.completed_at := now();
      new.completed_by := auth.uid();
    elsif new.status = 'open' then
      new.completed_at := null;
      new.completed_by := null;
    end if;
  end if;

  return new;
end;
$$;

create trigger list_entries_before_update
  before update on public.list_entries
  for each row execute function public.list_entries_before_update();

-- 2c. After update: turn status changes into purchases and feedback.
--     SECURITY DEFINER because it writes the engine-owned tables.
create or replace function public.list_entries_after_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_list_type         public.list_type;
  v_pattern           public.item_patterns%rowtype;
  v_days_since_last   numeric;
begin
  -- Step 2c-1: only status changes on shopping lines with an item matter.
  if new.status is not distinct from old.status or new.item_id is null then
    return null;
  end if;

  select l.type into v_list_type from public.lists l where l.id = new.list_id;
  if v_list_type <> 'shopping' then
    return null;
  end if;

  select * into v_pattern from public.item_patterns p where p.item_id = new.item_id;
  v_days_since_last := round(
    (extract(epoch from (now() - v_pattern.last_purchased_at)) / 86400)::numeric, 2
  );

  -- Step 2c-2: ticked off -> record a purchase (+ feedback where relevant).
  if new.status = 'done' and old.status = 'open' then
    insert into public.purchase_events (household_id, item_id, list_entry_id, purchased_at, purchased_by)
    values (new.household_id, new.item_id, new.id, now(), auth.uid())
    on conflict (list_entry_id) do nothing;

    if new.source = 'suggested' then
      -- The suggestion was right: confirms the current timing.
      insert into public.suggestion_feedback (household_id, item_id, list_entry_id, outcome, days_since_last_purchase)
      values (new.household_id, new.item_id, new.id, 'accepted', v_days_since_last);
    elsif v_pattern.next_expected_at is not null
          and v_pattern.confidence >= 0.45
          and now() < v_pattern.next_expected_at then
      -- Bought by hand before the engine would have suggested it:
      -- the engine is running late for this item, so it should come sooner.
      insert into public.suggestion_feedback (household_id, item_id, list_entry_id, outcome, days_since_last_purchase)
      values (new.household_id, new.item_id, new.id, 'bought_early', v_days_since_last);
    end if;

  -- Step 2c-3: unticked -> undo the purchase and any feedback it created.
  elsif old.status = 'done' and new.status = 'open' then
    delete from public.purchase_events where list_entry_id = new.id;
    delete from public.suggestion_feedback
      where list_entry_id = new.id and outcome in ('accepted', 'bought_early');

  -- Step 2c-4: suggestion dismissed ("Not now") -> wait longer next time.
  elsif new.status = 'dismissed' and old.status = 'open' and new.source = 'suggested' then
    insert into public.suggestion_feedback (household_id, item_id, list_entry_id, outcome, days_since_last_purchase)
    values (new.household_id, new.item_id, new.id, 'dismissed', v_days_since_last);

  else
    -- e.g. done -> cleared: nothing to learn.
    return null;
  end if;

  -- Step 2c-5: re-learn this item's rhythm with the new information.
  perform public.compute_item_pattern(new.item_id);
  return null;
end;
$$;


-- -----------------------------------------------------------------------------
-- STEP 3: Pattern calculator
-- -----------------------------------------------------------------------------
-- Recomputes one item's row in item_patterns from scratch. Pure function of
-- purchase_events + suggestion_feedback, so it is always safe to re-run.
create or replace function public.compute_item_pattern(p_item_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_household_id   uuid;
  v_timezone       text;
  v_shop_days      int;
  v_interval_count int;
  v_last_purchase  timestamptz;
  v_median         numeric;
  v_stddev         numeric;
  v_factor         numeric;
  v_confidence     numeric;
  v_next_expected  timestamptz;
begin
  -- Step 3a: find the item's household and its timezone.
  select i.household_id, h.timezone
    into v_household_id, v_timezone
  from public.items i
  join public.households h on h.id = i.household_id
  where i.id = p_item_id;

  if v_household_id is null then
    return;
  end if;

  -- Step 3b: collapse purchases into shopping days and measure the gaps.
  with shop_days as (
    select (pe.purchased_at at time zone v_timezone)::date as shop_day,
           max(pe.purchased_at)                           as last_at
    from public.purchase_events pe
    where pe.item_id = p_item_id
    group by 1
  ),
  gaps as (
    select (shop_day - lag(shop_day) over (order by shop_day))::numeric as gap_days
    from shop_days
  )
  select
    (select count(*) from shop_days),
    (select max(last_at) from shop_days),
    (select count(*) from gaps where gap_days is not null),
    (select percentile_cont(0.5) within group (order by gap_days) from gaps where gap_days is not null),
    (select coalesce(stddev_samp(gap_days), 0) from gaps where gap_days is not null)
  into v_shop_days, v_last_purchase, v_interval_count, v_median, v_stddev;

  -- Step 3c: never bought (e.g. the only purchase was unticked) -> forget it.
  if v_shop_days = 0 then
    delete from public.item_patterns where item_id = p_item_id;
    return;
  end if;

  -- Step 3d: timing factor from the last 8 pieces of feedback.
  --   dismissed    +0.08  (suggested too early, wait longer)
  --   bought_early -0.05  (suggested too late, come sooner)
  --   accepted      0     (timing was right)
  select least(1.30, greatest(0.60, 0.85 + coalesce(sum(
           case f.outcome
             when 'dismissed'    then  0.08
             when 'bought_early' then -0.05
             else 0
           end), 0)))
    into v_factor
  from (
    select sf.outcome
    from public.suggestion_feedback sf
    where sf.item_id = p_item_id
    order by sf.created_at desc
    limit 8
  ) f;

  -- Step 3e: with 3+ shopping days, work out confidence and the next due date.
  --   Confidence blends how regular the gaps are (60%) with how much history
  --   there is (40%, full marks from 4 gaps upwards).
  if v_shop_days >= 3 and v_median > 0 then
    v_confidence := round(
      0.6 * (1 - least(v_stddev / v_median, 1))
      + 0.4 * least(v_interval_count / 4.0, 1),
      3
    );
    v_next_expected := v_last_purchase
      + make_interval(secs => (v_median * v_factor * 86400)::double precision);
  else
    v_median := null;
    v_stddev := null;
    v_confidence := null;
    v_next_expected := null;
  end if;

  -- Step 3f: save.
  insert into public.item_patterns as p (
    item_id, household_id, purchase_count, median_interval_days, interval_stddev,
    last_purchased_at, next_expected_at, confidence, threshold_factor, updated_at
  )
  values (
    p_item_id, v_household_id, v_shop_days, round(v_median, 2), round(v_stddev, 2),
    v_last_purchase, v_next_expected, v_confidence, v_factor, now()
  )
  on conflict (item_id) do update set
    purchase_count       = excluded.purchase_count,
    median_interval_days = excluded.median_interval_days,
    interval_stddev      = excluded.interval_stddev,
    last_purchased_at    = excluded.last_purchased_at,
    next_expected_at     = excluded.next_expected_at,
    confidence           = excluded.confidence,
    threshold_factor     = excluded.threshold_factor,
    updated_at           = excluded.updated_at;
end;
$$;

-- The after-update trigger references compute_item_pattern, so it is
-- attached only now that the function exists.
create trigger list_entries_after_update
  after update on public.list_entries
  for each row execute function public.list_entries_after_update();


-- -----------------------------------------------------------------------------
-- STEP 4: Suggestion engine
-- -----------------------------------------------------------------------------

-- Minimum confidence before the engine is allowed to add anything.
-- 0.45 roughly means "3 purchases with fairly even gaps".
create or replace function public.suggestion_min_confidence()
returns numeric
language sql
immutable
as $$ select 0.45::numeric $$;

-- 4a. Add every item that is due to one household's default shopping list.
--     Returns how many suggestions were added.
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
  -- Step 4a-1: pick the list to add to (default shopping list, else the first one).
  select l.id into v_target_list
  from public.lists l
  where l.household_id = p_household_id and l.type = 'shopping'
  order by l.is_default desc, l.sort_order, l.created_at
  limit 1;

  if v_target_list is null then
    return 0;
  end if;

  -- Step 4a-2: find items that are due and not already on any list.
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
    -- Step 4a-3: add it as a suggested line.
    insert into public.list_entries (list_id, household_id, item_id, text, source, status)
    values (v_target_list, p_household_id, v_due.item_id, v_due.display_name, 'suggested', 'open');
    v_added := v_added + 1;
  end loop;

  return v_added;
end;
$$;

-- 4b. Nightly job: run the engine for every household.
create or replace function public.run_all_predictions()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total int := 0;
  v_household record;
begin
  for v_household in select id from public.households loop
    v_total := v_total + public.run_predictions(v_household.id);
  end loop;
  return v_total;
end;
$$;


-- -----------------------------------------------------------------------------
-- STEP 5: RPCs called by the app
-- -----------------------------------------------------------------------------

-- 5a. Shared guard: signed in, allowlisted and (optionally) not yet in a household.
create or replace function public.assert_can_onboard()
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;
  if not public.is_email_allowed() then
    raise exception 'email_not_allowed';
  end if;
  if exists (select 1 from public.members m where m.user_id = auth.uid()) then
    raise exception 'already_in_household';
  end if;
end;
$$;

-- 5b. Create a household with a Groceries and a To-do list.
create or replace function public.create_household(
  p_name         text,
  p_display_name text,
  p_avatar_url   text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_household_id uuid;
begin
  perform public.assert_can_onboard();

  -- Step 5b-1: the household itself.
  insert into public.households (name)
  values (coalesce(nullif(btrim(p_name), ''), 'Our home'))
  returning id into v_household_id;

  -- Step 5b-2: the creator becomes its first member.
  insert into public.members (household_id, user_id, display_name, email, avatar_url)
  values (
    v_household_id,
    auth.uid(),
    coalesce(nullif(btrim(p_display_name), ''), split_part(auth.jwt() ->> 'email', '@', 1)),
    lower(auth.jwt() ->> 'email'),
    p_avatar_url
  );

  -- Step 5b-3: starter lists.
  insert into public.lists (household_id, name, type, is_default, sort_order) values
    (v_household_id, 'Groceries', 'shopping', true,  0),
    (v_household_id, 'To-do',     'todo',     false, 1);

  return v_household_id;
end;
$$;

-- 5c. Join an existing household with its invite code.
create or replace function public.join_household(
  p_invite_code  text,
  p_display_name text,
  p_avatar_url   text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_household_id uuid;
begin
  perform public.assert_can_onboard();

  -- Step 5c-1: look the code up (case and spaces don't matter).
  select h.id into v_household_id
  from public.households h
  where h.invite_code = upper(regexp_replace(coalesce(p_invite_code, ''), '\s', '', 'g'));

  if v_household_id is null then
    raise exception 'invite_code_not_found';
  end if;

  -- Step 5c-2: keep households small.
  if (select count(*) from public.members m where m.household_id = v_household_id) >= 8 then
    raise exception 'household_full';
  end if;

  -- Step 5c-3: add the member.
  insert into public.members (household_id, user_id, display_name, email, avatar_url)
  values (
    v_household_id,
    auth.uid(),
    coalesce(nullif(btrim(p_display_name), ''), split_part(auth.jwt() ->> 'email', '@', 1)),
    lower(auth.jwt() ->> 'email'),
    p_avatar_url
  );

  return v_household_id;
end;
$$;

-- 5d. Issue a fresh invite code (the old one stops working).
create or replace function public.regenerate_invite_code()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text;
begin
  if public.current_household_id() is null then
    raise exception 'not_in_household';
  end if;

  update public.households
     set invite_code = public.generate_invite_code()
   where id = public.current_household_id()
  returning invite_code into v_code;

  return v_code;
end;
$$;

-- 5e. Add a line to a list. For shopping lists this also resolves the line to
--     a catalogue item, and if that item is already open on the list it
--     returns the existing line instead of creating a duplicate.
create or replace function public.add_entry(
  p_list_id  uuid,
  p_text     text,
  p_quantity text default null,
  p_category text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_household_id uuid := public.current_household_id();
  v_list_type    public.list_type;
  v_text         text := btrim(coalesce(p_text, ''));
  v_item_id      uuid;
  v_entry_id     uuid;
begin
  -- Step 5e-1: validate the caller, the list and the text.
  if v_household_id is null then
    raise exception 'not_in_household';
  end if;

  select l.type into v_list_type
  from public.lists l
  where l.id = p_list_id and l.household_id = v_household_id;

  if v_list_type is null then
    raise exception 'list_not_found';
  end if;
  if v_text = '' then
    raise exception 'empty_text';
  end if;

  -- Step 5e-2: to-do lists are plain text.
  if v_list_type = 'todo' then
    insert into public.list_entries (list_id, household_id, text, quantity, added_by)
    values (p_list_id, v_household_id, v_text, p_quantity, auth.uid())
    returning id into v_entry_id;
    return v_entry_id;
  end if;

  -- Step 5e-3: shopping lists resolve to an item. A known item keeps its
  -- category unless it was still "Other" and we now know better.
  insert into public.items (household_id, canonical_name, display_name, category)
  values (v_household_id, public.normalize_item_name(v_text), v_text,
          coalesce(nullif(btrim(p_category), ''), 'Other'))
  on conflict (household_id, canonical_name) do update
    set category = case
                     when public.items.category = 'Other' and excluded.category <> 'Other'
                       then excluded.category
                     else public.items.category
                   end
  returning id into v_item_id;

  -- Step 5e-4: reuse an open line for the same item (e.g. a suggestion).
  select e.id into v_entry_id
  from public.list_entries e
  where e.list_id = p_list_id and e.item_id = v_item_id and e.status = 'open'
  limit 1;

  if v_entry_id is not null then
    update public.list_entries
       set quantity = coalesce(nullif(btrim(coalesce(p_quantity, '')), ''), quantity)
     where id = v_entry_id;
    return v_entry_id;
  end if;

  -- Step 5e-5: otherwise add a new line.
  insert into public.list_entries (list_id, household_id, item_id, text, quantity, added_by)
  values (p_list_id, v_household_id, v_item_id, v_text, p_quantity, auth.uid())
  returning id into v_entry_id;

  return v_entry_id;
end;
$$;

-- 5f. Run the engine for the caller's household right now. The app calls this
--     when a shopping list opens, so suggestions appear without waiting for
--     the nightly job.
create or replace function public.refresh_suggestions()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_household_id uuid := public.current_household_id();
begin
  if v_household_id is null then
    raise exception 'not_in_household';
  end if;
  return public.run_predictions(v_household_id);
end;
$$;


-- -----------------------------------------------------------------------------
-- STEP 6: Function permissions
-- -----------------------------------------------------------------------------
-- Supabase lets every role execute new public functions by default. Lock that
-- down, then open up exactly what the browser needs.

revoke execute on all functions in schema public from public, anon, authenticated;

grant execute on function
  public.current_household_id(),
  public.is_email_allowed(),
  public.normalize_item_name(text),
  public.suggestion_min_confidence(),
  public.create_household(text, text, text),
  public.join_household(text, text, text),
  public.regenerate_invite_code(),
  public.add_entry(uuid, text, text, text),
  public.refresh_suggestions()
to authenticated;

-- Internal only (triggers, cron): compute_item_pattern, run_predictions,
-- run_all_predictions, assert_can_onboard, generate_invite_code and the
-- trigger functions stay revoked.
-- generate_invite_code is the households.invite_code default, so inserts by
-- SECURITY DEFINER functions (owned by postgres) still work.
