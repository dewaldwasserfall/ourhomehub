-- =============================================================================
-- HomeHub: per-person themes
-- -----------------------------------------------------------------------------
-- Each member picks an accent colour and Light / Dark / Automatic. Saved on
-- their own member row, which they can already update ("members: update self"),
-- so the choice follows them to every device. The list of accents must match
-- ACCENTS in src/lib/themes.ts.
-- =============================================================================

alter table public.members
  add column theme_accent text not null default 'basil'
    check (theme_accent in ('basil', 'ocean', 'indigo', 'lavender', 'berry', 'coral', 'sunflower', 'slate')),
  add column theme_mode text not null default 'system'
    check (theme_mode in ('system', 'light', 'dark'));

comment on column public.members.theme_accent is 'Accent colour id, see src/lib/themes.ts.';
comment on column public.members.theme_mode is 'system (follow the device), light or dark.';
