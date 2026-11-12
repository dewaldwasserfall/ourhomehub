-- =============================================================================
-- Household Hub: time-limited access (e.g. an au pair until a fixed date)
-- -----------------------------------------------------------------------------
-- What this migration changes:
--   1. app_allowlist gets an optional expires_at.
--   2. is_email_allowed() ignores expired entries (blocks sign-in/onboarding).
--   3. current_household_id() now also requires a live allowlist entry.
--      Every RLS policy goes through this function, so removing someone from
--      the allowlist, or letting their entry expire, cuts off their access to
--      all household data immediately, even with an active session.
--
-- Their member row and everything they added stay in place, so the shopping
-- history they contributed keeps teaching the prediction engine.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- STEP 1: optional end date per allowed email
-- -----------------------------------------------------------------------------
alter table public.app_allowlist
  add column expires_at timestamptz;

comment on column public.app_allowlist.expires_at is
  'Access ends at this moment. Null means no end date.';


-- -----------------------------------------------------------------------------
-- STEP 2: sign-in / onboarding check respects the end date
-- -----------------------------------------------------------------------------
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
      and (a.expires_at is null or a.expires_at > now())
  );
$$;


-- -----------------------------------------------------------------------------
-- STEP 3: household access requires a live allowlist entry
-- -----------------------------------------------------------------------------
-- The email is taken from the member row (recorded from Google at join time),
-- not from the token, so it can't be swapped for another address.
create or replace function public.current_household_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select m.household_id
  from public.members m
  join public.app_allowlist a on a.email = lower(m.email)
  where m.user_id = auth.uid()
    and (a.expires_at is null or a.expires_at > now());
$$;
