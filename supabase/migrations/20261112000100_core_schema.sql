-- =============================================================================
-- Household Hub: core schema (V1)
-- -----------------------------------------------------------------------------
-- What this migration creates:
--   1. Enum types for lists and list entries
--   2. Access control: the sign-in allowlist and household membership
--   3. Lists, items, list entries
--   4. Purchase history and the learned purchase patterns
--   5. Helper functions used by Row Level Security
--   6. Row Level Security policies on every table
--
-- The prediction engine and the RPCs the app calls live in the next migration.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- STEP 1: Enum types
-- -----------------------------------------------------------------------------

-- A list is either a shopping list (items get purchased and learned from)
-- or a plain to-do list (no learning, no categories).
create type public.list_type as enum ('shopping', 'todo');

-- Lifecycle of a single line on a list:
--   open      -> still needs doing / buying
--   done      -> ticked off (for shopping lists this records a purchase)
--   dismissed -> a suggestion the household said "not now" to
--   cleared   -> a done line that was tidied away with "Clear completed"
create type public.entry_status as enum ('open', 'done', 'dismissed', 'cleared');

-- Where a line came from: typed by a person, or added by the prediction engine.
create type public.entry_source as enum ('manual', 'suggested');

-- Signals that tune the timing of suggestions for an item:
--   accepted     -> a suggestion was ticked off (timing was right)
--   dismissed    -> a suggestion got "Not now" (too early)
--   bought_early -> bought by hand before the engine suggested it (too late)
create type public.feedback_outcome as enum ('accepted', 'dismissed', 'bought_early');


-- -----------------------------------------------------------------------------
-- STEP 2: Access control tables
-- -----------------------------------------------------------------------------

-- Only Google accounts listed here can create or join a household.
-- RLS is enabled with no policies, so the browser can never read or edit it;
-- manage it from the Supabase SQL editor or table editor.
create table public.app_allowlist (
  email       text primary key check (email = lower(email)),
  note        text,
  created_at  timestamptz not null default now()
);

-- Six characters from an unambiguous alphabet (no 0/O, 1/I/L), so the code
-- can be read out loud or typed from a screenshot without mistakes.
-- Postgres does not allow subqueries in a column DEFAULT, hence a function.
create or replace function public.generate_invite_code()
returns text
language sql
volatile
as $$
  select string_agg(
    substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 1 + floor(random() * 31)::int, 1), ''
  )
  from generate_series(1, 6);
$$;

-- One row per household. The invite code lets a second person join.
create table public.households (
  id           uuid primary key default gen_random_uuid(),
  name         text not null check (char_length(name) between 1 and 60),
  invite_code  text not null unique default public.generate_invite_code(),
  -- Used to decide what counts as "the same shopping day".
  timezone     text not null default 'Europe/Amsterdam',
  created_at   timestamptz not null default now()
);

-- Links a signed-in user to their household. In V1 a user belongs to exactly
-- one household, enforced by the unique constraint on user_id.
create table public.members (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references public.households (id) on delete cascade,
  user_id       uuid not null unique references auth.users (id) on delete cascade,
  display_name  text not null,
  email         text,
  avatar_url    text,
  created_at    timestamptz not null default now()
);
create index members_household_idx on public.members (household_id);


-- -----------------------------------------------------------------------------
-- STEP 3: Lists, items and list entries
-- -----------------------------------------------------------------------------

create table public.lists (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references public.households (id) on delete cascade,
  name          text not null check (char_length(name) between 1 and 40),
  type          public.list_type not null default 'shopping',
  -- The default shopping list is where the prediction engine adds suggestions.
  is_default    boolean not null default false,
  sort_order    int not null default 0,
  created_at    timestamptz not null default now()
);
create index lists_household_idx on public.lists (household_id);
-- At most one default list per household.
create unique index lists_one_default_per_household
  on public.lists (household_id) where is_default;

-- The household's catalogue of things it buys. "Coffee beans", "coffee bean"
-- and " Coffee  Beans " all resolve to one item via canonical_name, so the
-- purchase history for coffee lives in one place.
create table public.items (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid not null references public.households (id) on delete cascade,
  canonical_name  text not null,
  display_name    text not null,
  category        text not null default 'Other',
  created_at      timestamptz not null default now(),
  unique (household_id, canonical_name)
);

-- One line on a list.
create table public.list_entries (
  id            uuid primary key default gen_random_uuid(),
  list_id       uuid not null references public.lists (id) on delete cascade,
  -- Copied from the list by a trigger so RLS and realtime filters stay cheap.
  household_id  uuid not null references public.households (id) on delete cascade,
  -- Null for free-text to-dos; always set for shopping lines.
  item_id       uuid references public.items (id) on delete set null,
  text          text not null check (char_length(text) between 1 and 200),
  quantity      text check (quantity is null or char_length(quantity) <= 30),
  note          text check (note is null or char_length(note) <= 500),
  status        public.entry_status not null default 'open',
  source        public.entry_source not null default 'manual',
  added_by      uuid references auth.users (id) on delete set null,
  added_at      timestamptz not null default now(),
  completed_by  uuid references auth.users (id) on delete set null,
  completed_at  timestamptz,
  updated_at    timestamptz not null default now()
);
create index list_entries_list_status_idx on public.list_entries (list_id, status);
create index list_entries_household_idx on public.list_entries (household_id);
create index list_entries_item_open_idx on public.list_entries (item_id) where status = 'open';


-- -----------------------------------------------------------------------------
-- STEP 4: Purchase history and learned patterns
-- -----------------------------------------------------------------------------

-- Written automatically when a shopping line is ticked off. Never written by
-- the browser directly (no insert policy).
create table public.purchase_events (
  id             uuid primary key default gen_random_uuid(),
  household_id   uuid not null references public.households (id) on delete cascade,
  item_id        uuid not null references public.items (id) on delete cascade,
  -- One purchase per ticked line; unticking removes it again.
  list_entry_id  uuid unique references public.list_entries (id) on delete set null,
  purchased_at   timestamptz not null default now(),
  purchased_by   uuid references auth.users (id) on delete set null
);
create index purchase_events_item_time_idx on public.purchase_events (item_id, purchased_at);

-- What the engine has learned about each item. One row per item once it has
-- been bought at least once. Fields stay null until there is enough history.
create table public.item_patterns (
  item_id               uuid primary key references public.items (id) on delete cascade,
  household_id          uuid not null references public.households (id) on delete cascade,
  -- Number of distinct shopping days this item was bought on.
  purchase_count        int not null default 0,
  median_interval_days  numeric(8, 2),
  interval_stddev       numeric(8, 2),
  last_purchased_at     timestamptz,
  -- When the engine will next add the item to the list.
  next_expected_at      timestamptz,
  -- 0..1. How regular and well-evidenced the rhythm is.
  confidence            numeric(4, 3),
  -- Fraction of the usual gap to wait before suggesting. Starts at 0.85
  -- (suggest a little before you run out) and is nudged by feedback.
  threshold_factor      numeric(4, 3) not null default 0.85
                        check (threshold_factor between 0.5 and 1.5),
  updated_at            timestamptz not null default now()
);
create index item_patterns_household_idx on public.item_patterns (household_id);

-- Every accept / dismiss of a suggestion, kept for transparency and tuning.
-- list_entry_id is deliberately not a foreign key: a dismissed suggestion may
-- be deleted from the list, but its feedback should survive.
create table public.suggestion_feedback (
  id                        uuid primary key default gen_random_uuid(),
  household_id              uuid not null references public.households (id) on delete cascade,
  item_id                   uuid not null references public.items (id) on delete cascade,
  list_entry_id             uuid,
  outcome                   public.feedback_outcome not null,
  days_since_last_purchase  numeric(8, 2),
  created_at                timestamptz not null default now()
);
create index suggestion_feedback_item_idx on public.suggestion_feedback (item_id, created_at desc);


-- -----------------------------------------------------------------------------
-- STEP 5: Helper functions used by RLS
-- -----------------------------------------------------------------------------

-- The household of the signed-in user, or null if they have not joined one.
-- SECURITY DEFINER so it can read members without recursing into members' RLS.
create or replace function public.current_household_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select m.household_id
  from public.members m
  where m.user_id = auth.uid();
$$;

-- True when the signed-in user's Google email is on the allowlist.
create or replace function public.is_email_allowed()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.app_allowlist a
    where a.email = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;


-- -----------------------------------------------------------------------------
-- STEP 6: Row Level Security
-- -----------------------------------------------------------------------------
-- Rule of thumb: you can see and change rows of your own household only.
-- Tables the engine owns (purchases, patterns, feedback) are read-only from
-- the browser; triggers and SECURITY DEFINER functions write them.

alter table public.app_allowlist       enable row level security;
alter table public.households          enable row level security;
alter table public.members             enable row level security;
alter table public.lists               enable row level security;
alter table public.items               enable row level security;
alter table public.list_entries        enable row level security;
alter table public.purchase_events     enable row level security;
alter table public.item_patterns       enable row level security;
alter table public.suggestion_feedback enable row level security;

-- 6a. Households: read and rename your own. Creating one goes through an RPC.
create policy "households: members read own"
  on public.households for select to authenticated
  using (id = public.current_household_id());

create policy "households: members rename own"
  on public.households for update to authenticated
  using (id = public.current_household_id())
  with check (id = public.current_household_id());

-- 6b. Members: see everyone in your household, edit only your own profile.
create policy "members: read household"
  on public.members for select to authenticated
  using (household_id = public.current_household_id());

create policy "members: update self"
  on public.members for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and household_id = public.current_household_id());

-- 6c. Lists: full access within the household.
create policy "lists: household access"
  on public.lists for all to authenticated
  using (household_id = public.current_household_id())
  with check (household_id = public.current_household_id());

-- 6d. Items: full access within the household.
create policy "items: household access"
  on public.items for all to authenticated
  using (household_id = public.current_household_id())
  with check (household_id = public.current_household_id());

-- 6e. List entries: full access within the household. The insert trigger fills
-- household_id from the list, so the check also proves the list is yours.
create policy "list_entries: household access"
  on public.list_entries for all to authenticated
  using (household_id = public.current_household_id())
  with check (household_id = public.current_household_id());

-- 6f. Engine-owned tables: read-only.
create policy "purchase_events: household read"
  on public.purchase_events for select to authenticated
  using (household_id = public.current_household_id());

create policy "item_patterns: household read"
  on public.item_patterns for select to authenticated
  using (household_id = public.current_household_id());

create policy "suggestion_feedback: household read"
  on public.suggestion_feedback for select to authenticated
  using (household_id = public.current_household_id());

-- app_allowlist intentionally has no policies: invisible to the browser.
