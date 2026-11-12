-- =============================================================================
-- Household Hub: pin search_path on the remaining helper functions
-- -----------------------------------------------------------------------------
-- Clears the Supabase security advisor warning "function_search_path_mutable".
-- These functions only use built-ins from pg_catalog, which is always searched,
-- so an empty search_path is safe and stops anything else being picked up.
-- =============================================================================
alter function public.normalize_item_name(text) set search_path = '';
alter function public.generate_invite_code() set search_path = '';
alter function public.suggestion_min_confidence() set search_path = '';
