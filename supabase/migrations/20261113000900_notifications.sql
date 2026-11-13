-- =============================================================================
-- HomeHub: push notifications
-- -----------------------------------------------------------------------------
-- What this migration creates:
--   1. push_subscriptions: one row per device that turned notifications on
--   2. notification_prefs: what each person wants, and when
--   3. notification_log: what was sent, so nothing goes out twice
--   4. RPCs the browser uses to register and remove a device
--   5. The 5-minute job: pg_cron calls HomeHub's /api/cron/notify through
--      pg_net, with a secret that lives only in Vault and is checked by the
--      server through notify_check_secret()
--   6. RLS and function permissions
--
-- Sending itself happens in the Next.js route (Web Push needs the VAPID key,
-- which never leaves the server).
-- =============================================================================


-- -----------------------------------------------------------------------------
-- STEP 1: Devices
-- -----------------------------------------------------------------------------
-- The endpoint identifies a browser on a device; Web Push needs the two keys
-- to encrypt messages for it. One device belongs to one person at a time: if
-- someone else signs in on it and turns notifications on, the row moves.
create table public.push_subscriptions (
  id            uuid primary key default gen_random_uuid(),
  member_id     uuid not null references public.members (id) on delete cascade,
  household_id  uuid not null references public.households (id) on delete cascade,
  endpoint      text not null unique check (endpoint like 'https://%'),
  p256dh        text not null,
  auth          text not null,
  device_label  text,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);
create index push_subscriptions_member_idx on public.push_subscriptions (member_id);


-- -----------------------------------------------------------------------------
-- STEP 2: Preferences (one row per person, created on first save)
-- -----------------------------------------------------------------------------
-- Times are wall-clock times in the household's time zone.
create table public.notification_prefs (
  member_id            uuid primary key references public.members (id) on delete cascade,
  household_id         uuid not null references public.households (id) on delete cascade,
  -- Calendar: N minutes before each timed event.
  events               boolean not null default true,
  event_lead_minutes   int not null default 30 check (event_lead_minutes between 5 and 240),
  -- Morning digest: to-dos and chores due today.
  digest               boolean not null default true,
  digest_time          time not null default '07:30',
  -- Routine nudge: at this time, if steps are still open.
  routine_nudge        boolean not null default false,
  routine_nudge_time   time not null default '07:45',
  -- Someone else added something to a shopping list.
  list_added           boolean not null default false,
  updated_at           timestamptz not null default now()
);


-- -----------------------------------------------------------------------------
-- STEP 3: What was sent (written by the server only)
-- -----------------------------------------------------------------------------
-- key examples: "event:<occurrence key>", "digest:2026-11-13",
-- "nudge:<routine id>:2026-11-13", "list:<entry id>". The unique constraint
-- is what makes sending idempotent when runs overlap.
create table public.notification_log (
  id         uuid primary key default gen_random_uuid(),
  member_id  uuid not null references public.members (id) on delete cascade,
  key        text not null,
  sent_at    timestamptz not null default now(),
  unique (member_id, key)
);
create index notification_log_sent_idx on public.notification_log (sent_at);


-- -----------------------------------------------------------------------------
-- STEP 4: RPCs for the browser
-- -----------------------------------------------------------------------------

-- 4a. Register (or re-register) this device for the signed-in person.
create or replace function public.save_push_subscription(
  p_endpoint     text,
  p_p256dh       text,
  p_auth         text,
  p_device_label text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_member_id    uuid := public.current_member_id();
  v_household_id uuid := public.current_household_id();
begin
  if v_member_id is null then
    raise exception 'not_in_household';
  end if;

  insert into public.push_subscriptions (member_id, household_id, endpoint, p256dh, auth, device_label)
  values (v_member_id, v_household_id, p_endpoint, p_p256dh, p_auth, left(p_device_label, 80))
  on conflict (endpoint) do update set
    member_id    = excluded.member_id,
    household_id = excluded.household_id,
    p256dh       = excluded.p256dh,
    auth         = excluded.auth,
    device_label = excluded.device_label;
end;
$$;

-- 4b. Turn notifications off on this device (only your own devices).
create or replace function public.remove_push_subscription(p_endpoint text)
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.push_subscriptions
  where endpoint = p_endpoint and member_id = public.current_member_id();
$$;


-- -----------------------------------------------------------------------------
-- STEP 5: The 5-minute job
-- -----------------------------------------------------------------------------
create extension if not exists pg_net with schema extensions;

-- 5a. A random secret, created once, kept in Vault. pg_cron sends it; the
--     route asks notify_check_secret() whether it matches. It never needs to
--     be copied anywhere.
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'homehub_notify_cron_secret') then
    perform vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'homehub_notify_cron_secret',
      'Authenticates the pg_cron call to /api/cron/notify'
    );
  end if;
end;
$$;

create or replace function public.notify_check_secret(p_secret text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from vault.decrypted_secrets s
    where s.name = 'homehub_notify_cron_secret' and s.decrypted_secret = p_secret
  );
$$;

-- 5b. Every 5 minutes: ask HomeHub to send whatever is due.
select cron.schedule(
  'homehub-notifications',
  '*/5 * * * *',
  $$
    select net.http_post(
      url     := 'https://ourhomehub.nl/api/cron/notify',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (
          select decrypted_secret from vault.decrypted_secrets where name = 'homehub_notify_cron_secret'
        )
      ),
      body    := '{}'::jsonb,
      timeout_milliseconds := 25000
    );
  $$
);

-- 5c. Keep the log small: anything older than 30 days can go (the job only
--     ever checks the last day or so).
select cron.schedule(
  'homehub-notification-log-cleanup',
  '20 3 * * *',
  $$ delete from public.notification_log where sent_at < now() - interval '30 days'; $$
);


-- -----------------------------------------------------------------------------
-- STEP 6: RLS and permissions
-- -----------------------------------------------------------------------------
alter table public.push_subscriptions enable row level security;
alter table public.notification_prefs enable row level security;
alter table public.notification_log   enable row level security;

-- 6a. Each person sees only their own devices (to show "On for this phone"),
--     and writes them only through the RPCs above.
create policy "push_subscriptions: own read" on public.push_subscriptions for select to authenticated
  using (member_id = public.current_member_id());

-- 6b. Each person reads and edits only their own preferences.
create policy "notification_prefs: own" on public.notification_prefs for all to authenticated
  using (member_id = public.current_member_id())
  with check (member_id = public.current_member_id() and household_id = public.current_household_id());

-- 6c. notification_log: no policies, server only.

revoke execute on function
  public.save_push_subscription(text, text, text, text),
  public.remove_push_subscription(text),
  public.notify_check_secret(text)
from public, anon, authenticated;

grant execute on function
  public.save_push_subscription(text, text, text, text),
  public.remove_push_subscription(text)
to authenticated;

grant execute on function public.notify_check_secret(text) to service_role;
