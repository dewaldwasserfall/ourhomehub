-- =============================================================================
-- HomeHub: chime on the Family board when a child earns a reward
-- -----------------------------------------------------------------------------
-- A per-board switch, off by default. Adults change it on Household → Family
-- board (the existing "adults rename" update policy on boards covers it); the
-- board reads its own row to know whether to play the chime.
-- =============================================================================
alter table public.boards
  add column celebrate_sound boolean not null default false;

comment on column public.boards.celebrate_sound is
  'Play a short chime with the celebration when a child earns a reward.';
