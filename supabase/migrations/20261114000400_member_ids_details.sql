-- =============================================================================
-- Passports and IDs: the details printed on the document's info page
-- =============================================================================
-- Adds the name as printed, issue date and place of issue to member_ids, so
-- the Passports & IDs page can answer "what name is on Shannon's passport?"
-- when booking flights. Still no document number or scan: those stay in
-- 1Password (see 20261114000300_trip_documents_ids.sql).
-- =============================================================================

alter table public.member_ids
  -- Full name exactly as on the document (airlines want it to match).
  add column holder_name    text not null default '' check (char_length(holder_name) <= 120),
  -- When it was issued; optional.
  add column issue_date     date,
  -- Where it was issued, e.g. "South Africa" or "Den Haag"; optional.
  add column place_of_issue text not null default '' check (char_length(place_of_issue) <= 80),
  -- A document can't be issued after it expires.
  add constraint member_ids_issue_before_expiry check (issue_date is null or issue_date < expiry_date);
