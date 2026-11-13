/**
 * Row types mirroring the database (see supabase/migrations).
 * Hand-written to keep V1 dependency-free; regenerate with
 * `supabase gen types typescript` once the schema settles.
 */

export type ListType = "shopping" | "todo";
export type EntryStatus = "open" | "done" | "dismissed" | "cleared";
export type EntrySource = "manual" | "suggested";

export type Role = "owner" | "adult" | "child";

/** The day's mode, from day_mode() / day_info() in the database. */
export type DayMode = "school" | "holiday" | "weekend";

/**
 * The household row as the browser may read it. The invite code is not a
 * readable column (children must not see it); adults fetch it with the
 * household_invite_code() RPC.
 */
export interface Household {
  id: string;
  name: string;
  timezone: string;
  /** School holiday region: noord, midden or zuid (Breda = zuid). */
  school_region: "noord" | "midden" | "zuid";
  /** Monday the fortnightly zone rotation started; null until set. */
  zone_rotation_start: string | null;
  created_at: string;
}

/** Columns the browser selects from households (never "*"). */
export const HOUSEHOLD_COLUMNS = "id, name, timezone, school_region, zone_rotation_start, created_at";

export interface Member {
  id: string;
  household_id: string;
  user_id: string;
  display_name: string;
  email: string | null;
  avatar_url: string | null;
  /**
   * owner: everything, incl. the calendar connection.
   * adult: everything else.
   * child: reads the household, ticks off only what is assigned to them.
   */
  role: Role;
  /** Accent colour id (src/lib/themes.ts) and Light / Dark / Automatic. */
  theme_accent: string;
  theme_mode: "system" | "light" | "dark";
  /** Sees the grocery budget (owner-granted; never children). */
  can_see_finances: boolean;
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
  /** To-dos only: optional due date (YYYY-MM-DD). */
  due_date: string | null;
  /** To-dos only: optional member id; null = anyone. */
  assigned_to: string | null;
}

/** A list entry joined with its item and that item's learned pattern. */
export interface ListEntryWithItem extends ListEntry {
  item: (Item & { pattern: ItemPattern | null }) | null;
}

/** An item joined with its pattern, as shown on the Rhythms screen. */
export interface ItemWithPattern extends Item {
  pattern: ItemPattern | null;
}

// -----------------------------------------------------------------------------
// Phase 3: holidays, routines, zones, chores, completions
// -----------------------------------------------------------------------------

export type OverrideKind = "holiday" | "public_holiday" | "day_off" | "school_day";

export interface DayOverride {
  id: string;
  household_id: string;
  start_date: string;
  end_date: string;
  kind: OverrideKind;
  name: string;
  source: "rijksoverheid" | "computed" | "manual";
  external_key: string | null;
  created_at: string;
}

/** One row of day_info(): what the Today header shows. */
export interface DayInfo {
  mode: DayMode;
  label: string | null;
  period_start: string | null;
  period_end: string | null;
}

export type TimeOfDay = "morning" | "afternoon" | "evening";

export interface Routine {
  id: string;
  household_id: string;
  name: string;
  time_of_day: TimeOfDay;
  /** null = a household routine; set = this member's own routine. */
  owner_member: string | null;
  sort_order: number;
  active: boolean;
  created_at: string;
}

export interface RoutineStep {
  id: string;
  routine_id: string;
  household_id: string;
  title: string;
  /** ISO weekdays 1 (Mon) .. 7 (Sun); null = every day. */
  weekdays: number[] | null;
  modes: DayMode[];
  assigned_to: string | null;
  sort_order: number;
  created_at: string;
}

export interface Zone {
  id: string;
  household_id: string;
  name: string;
  sort_order: number;
  created_at: string;
}

export interface ZoneTask {
  id: string;
  zone_id: string;
  household_id: string;
  title: string;
  assigned_to: string | null;
  sort_order: number;
  created_at: string;
}

export type ChoreUnit = "day" | "week" | "month";

export interface Chore {
  id: string;
  household_id: string;
  title: string;
  every_n: number;
  unit: ChoreUnit;
  modes: DayMode[];
  assigned_to: string | null;
  next_due: string;
  active: boolean;
  created_at: string;
}

export type CompletionKind = "step" | "zone_task" | "chore";

export interface Completion {
  id: string;
  household_id: string;
  kind: CompletionKind;
  item_id: string;
  for_date: string;
  done_by: string | null;
  done_at: string;
}

/** A product that runs down with use (washing liquid: 40 uses a bottle). */
export interface Supply {
  id: string;
  household_id: string;
  item_id: string;
  uses_per_pack: number;
  uses_left: number;
  /** Suggested on the shopping list at this many uses left. */
  warn_at: number;
  suggested_at_uses: number | null;
  created_at: string;
}

/** A task that uses up a supply each time it's ticked. */
export interface SupplyUse {
  supply_id: string;
  household_id: string;
  kind: CompletionKind;
  task_id: string;
  created_at: string;
}
