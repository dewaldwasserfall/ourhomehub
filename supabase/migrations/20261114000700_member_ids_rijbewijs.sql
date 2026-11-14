-- =============================================================================
-- Vault: driving licences (rijbewijs)
-- -----------------------------------------------------------------------------
-- A third kind of document next to passports and ID cards. Same rule as the
-- others: HomeHub keeps the expiry date, name, issue details and the
-- 1Password link; the licence number and the BSN printed on it stay in
-- 1Password. Expiry reminders cover it too; trip warnings don't (it isn't a
-- travel document).
-- =============================================================================

alter table public.member_ids drop constraint member_ids_kind_check;
alter table public.member_ids
  add constraint member_ids_kind_check check (kind in ('passport', 'id_card', 'drivers_license'));
