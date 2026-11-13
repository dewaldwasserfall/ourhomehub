/**
 * Import school holidays and public holidays into day_overrides.
 *
 * SERVER ONLY (service-role client). Called by:
 *   * POST /api/holidays/import  an adult taps "Update" on School holidays
 *   * GET  /api/cron/holidays    weekly, for every household
 *
 * Fetches this school year and next (next is usually published a year or
 * more ahead) and works out public holidays for this calendar year and next.
 * Rows are upserted on (household_id, external_key), so running it again
 * only updates dates. Your own days (no external_key) are never touched.
 */
import { dateKey } from "./calendar/time";
import { dutchPublicHolidays, feedUrl, nextSchoolYear, parseSchoolHolidays, schoolYearOf, type OverrideRow, type Region } from "./holidays";
import { getSupabaseAdminClient } from "./supabase/admin";

export interface ImportResult {
  schoolHolidays: number;
  publicHolidays: number;
  /** School years the feed had no data for yet (not an error). */
  missingYears: string[];
}

/** Step 1: one school year from the feed; null when it isn't published yet. */
async function fetchSchoolYear(schoolYear: string, region: Region): Promise<OverrideRow[] | null> {
  const res = await fetch(feedUrl(schoolYear), { headers: { Accept: "application/json" }, cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Holiday feed answered ${res.status} for ${schoolYear}`);
  const rows = parseSchoolHolidays(await res.json(), region);
  return rows.length ? rows : null;
}

export async function importHolidays(householdId: string): Promise<ImportResult> {
  const admin = getSupabaseAdminClient();

  // Step 2: the household's region and today's date in its time zone.
  const { data: household, error } = await admin
    .from("households")
    .select("school_region, timezone")
    .eq("id", householdId)
    .single<{ school_region: Region; timezone: string }>();
  if (error || !household) throw new Error("Household not found");
  const today = dateKey(new Date(), household.timezone);

  // Step 3: school holidays for this school year and next.
  const thisYear = schoolYearOf(today);
  const years = [thisYear, nextSchoolYear(thisYear)];
  const missingYears: string[] = [];
  const school: OverrideRow[] = [];
  for (const year of years) {
    const rows = await fetchSchoolYear(year, household.school_region);
    if (rows) school.push(...rows);
    else missingYears.push(year);
  }

  // Step 4: public holidays for this calendar year and next.
  const calendarYear = Number(today.slice(0, 4));
  const publicDays = [...dutchPublicHolidays(calendarYear), ...dutchPublicHolidays(calendarYear + 1)];

  // Step 5: a region change leaves the old region's rows behind; remove
  //         imported school holidays for other regions first.
  await admin
    .from("day_overrides")
    .delete()
    .eq("household_id", householdId)
    .eq("source", "rijksoverheid")
    .not("external_key", "like", `school:${household.school_region}:%`);

  // Step 6: upsert everything in one go.
  const rows = [...school, ...publicDays].map((r) => ({ ...r, household_id: householdId }));
  const { error: upsertError } = await admin.from("day_overrides").upsert(rows, { onConflict: "household_id,external_key" });
  if (upsertError) throw new Error(upsertError.message);

  return { schoolHolidays: school.length, publicHolidays: publicDays.length, missingYears };
}
