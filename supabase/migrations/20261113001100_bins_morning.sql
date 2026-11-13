-- =============================================================================
-- HomeHub: bins reminder on the morning of collection
-- -----------------------------------------------------------------------------
-- Many households put the bins out in the morning, so besides the evening-
-- before reminder (bins / bins_time) each person can get one on the day itself.
-- =============================================================================

alter table public.notification_prefs
  add column bins_morning boolean not null default true,
  add column bins_morning_time time not null default '07:00';
