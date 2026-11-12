/**
 * Row types mirroring the database (see supabase/migrations).
 * Hand-written to keep V1 dependency-free; regenerate with
 * `supabase gen types typescript` once the schema settles.
 */

export type ListType = "shopping" | "todo";
export type EntryStatus = "open" | "done" | "dismissed" | "cleared";
export type EntrySource = "manual" | "suggested";

export interface Household {
  id: string;
  name: string;
  invite_code: string;
  timezone: string;
  created_at: string;
}

export interface Member {
  id: string;
  household_id: string;
  user_id: string;
  display_name: string;
  email: string | null;
  avatar_url: string | null;
  /** Owners manage the household's calendar connection. */
  role: "owner" | "member";
  created_at: string;
}

export interface List {
  id: string;
  household_id: string;
  name: string;
  type: ListType;
  is_default: boolean;
  sort_order: number;
  created_at: string;
}

export interface Item {
  id: string;
  household_id: string;
  canonical_name: string;
  display_name: string;
  category: string;
}

export interface ItemPattern {
  item_id: string;
  household_id: string;
  purchase_count: number;
  median_interval_days: number | null;
  interval_stddev: number | null;
  last_purchased_at: string | null;
  next_expected_at: string | null;
  confidence: number | null;
  threshold_factor: number;
  updated_at: string;
}

export interface ListEntry {
  id: string;
  list_id: string;
  household_id: string;
  item_id: string | null;
  text: string;
  quantity: string | null;
  note: string | null;
  status: EntryStatus;
  source: EntrySource;
  added_by: string | null;
  added_at: string;
  completed_by: string | null;
  completed_at: string | null;
  updated_at: string;
}

/** A list entry joined with its item and that item's learned pattern. */
export interface ListEntryWithItem extends ListEntry {
  item: (Item & { pattern: ItemPattern | null }) | null;
}

/** An item joined with its pattern, as shown on the Rhythms screen. */
export interface ItemWithPattern extends Item {
  pattern: ItemPattern | null;
}
