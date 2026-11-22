-- =============================================================================
-- HomeHub: money passed straight through the groceries account
-- -----------------------------------------------------------------------------
-- Toeslagen (from the Belastingdienst) are paid into the groceries account
-- and moved straight on to savings (a transfer to Dewald). Neither is grocery
-- money: they shouldn't count as money added or as spending, or show in the
-- overview.
--
--   * bunq_payments.kind gains 'passthrough'.
--   * bunq_connections.passthrough_from / passthrough_to: the payers and the
--     accounts (as shop keys: the first word of the name, lower case) of the
--     rule. Money in from a "from" payer is passed through; money out to a
--     "to" account is too, when it follows such money in within 7 days for
--     about the same amount (src/lib/budget.ts, passThroughIds). The owner
--     edits them in Budget → Settings.
--   * This household starts with Belastingdienst → Dewald, and the next sync
--     (within 5 minutes) reclassifies the last three months.
-- =============================================================================

-- Step 1: the new kind.
alter table public.bunq_payments drop constraint bunq_payments_kind_check;
alter table public.bunq_payments
  add constraint bunq_payments_kind_check check (kind in ('spend', 'refund', 'topup', 'passthrough'));

-- Step 2: the rule.
alter table public.bunq_connections
  add column passthrough_from text[] not null default '{}',
  add column passthrough_to   text[] not null default '{}';

comment on column public.bunq_connections.passthrough_from is 'Payers whose money only passes through (shop keys), e.g. {belastingdienst}.';
comment on column public.bunq_connections.passthrough_to is 'Accounts it is moved on to (shop keys), e.g. {dewald}.';

-- Step 3: toeslagen moved on to Dewald, and sync again soon to reclassify.
update public.bunq_connections
   set passthrough_from = '{belastingdienst}',
       passthrough_to = '{dewald}',
       last_synced_at = null;
