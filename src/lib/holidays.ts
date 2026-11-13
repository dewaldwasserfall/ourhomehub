/**
 * School holidays and Dutch public holidays, as pure functions.
 *
 *   * School holidays come from the government's open data feed
 *     (opendata.rijksoverheid.nl), one school year per request.
 *   * Public holidays are worked out here, every year, from the date of
 *     Easter and the fixed dates. The feed doesn't include them.
 *
 * Both become day_overrides rows with a stable external_key, so importing
 * again updates rows in place instead of adding duplicates.
 */
import type { OverrideKind } from "./types";

export type Region = "noord" | "midden" | "zuid";

export interface OverrideRow {
  start_date: string;
  end_date: string;
  kind: OverrideKind;
  name: string;
  source: "rijksoverheid" | "computed";
  external_key: string;
}

// -----------------------------------------------------------------------------
// Step 1: school years
// -----------------------------------------------------------------------------

/**
 * The school year a date falls in, as the feed names it ("2026-2027").
 * Dutch school years start after the summer holiday; August counts as the
 * new year so next year's dates are fetched in time.
 */
export function schoolYearOf(date: string): string {
  const [y, m] = date.split("-").map(Number);
  return m >= 8 ? `${y}-${y + 1}` : `${y - 1}-${y}`;
}

/** The following school year ("2026-2027" -> "2027-2028"). */
export function nextSchoolYear(year: string): string {
  const start = Number(year.slice(0, 4)) + 1;
  return `${start}-${start + 1}`;
}

export function feedUrl(schoolYear: string): string {
  return `https://opendata.rijksoverheid.nl/v1/infotypes/schoolholidays/schoolyear/${schoolYear}?output=json`;
}

// -----------------------------------------------------------------------------
// Step 2: reading the government feed
// -----------------------------------------------------------------------------

/** English names for the holidays the feed lists (in Dutch). */
const HOLIDAY_NAMES: Record<string, string> = {
  herfstvakantie: "Autumn holiday",
  kerstvakantie: "Christmas holiday",
  voorjaarsvakantie: "Spring holiday",
  meivakantie: "May holiday",
  zomervakantie: "Summer holiday",
};

interface FeedRegion {
  region?: string;
  startdate?: string;
  enddate?: string;
}

interface FeedVacation {
  type?: string;
  regions?: FeedRegion[];
}

interface Feed {
  content?: Array<{ schoolyear?: string; vacations?: FeedVacation[] }>;
}

/**
 * The feed's dates are instants: a start at 00:00Z on the first day and an
 * end at 21:59Z / 22:59Z, which is 23:59 on the last day in Dutch time. The
 * first ten characters of each are therefore the right calendar days.
 */
function feedDay(instant: string | undefined): string | null {
  return instant && /^\d{4}-\d{2}-\d{2}/.test(instant) ? instant.slice(0, 10) : null;
}

/** Turn one school year's feed into holiday rows for one region. */
export function parseSchoolHolidays(feed: unknown, region: Region): OverrideRow[] {
  const rows: OverrideRow[] = [];
  for (const block of (feed as Feed)?.content ?? []) {
    const year = (block.schoolyear ?? "").trim();
    for (const vacation of block.vacations ?? []) {
      const dutch = (vacation.type ?? "").trim();
      if (!dutch) continue;

      // Step 2a: this region's dates, or the nationwide ones.
      const match =
        vacation.regions?.find((r) => r.region?.trim().toLowerCase() === region) ??
        vacation.regions?.find((r) => r.region?.trim().toLowerCase() === "heel nederland");
      const start = feedDay(match?.startdate);
      const end = feedDay(match?.enddate);
      if (!start || !end || end < start) continue;

      rows.push({
        start_date: start,
        end_date: end,
        kind: "holiday",
        name: HOLIDAY_NAMES[dutch.toLowerCase()] ?? dutch,
        source: "rijksoverheid",
        external_key: `school:${region}:${year}:${dutch.toLowerCase()}`,
      });
    }
  }
  return rows;
}

// -----------------------------------------------------------------------------
// Step 3: Dutch public holidays
// -----------------------------------------------------------------------------

/** Easter Sunday (Gregorian), by the anonymous Gregorian algorithm. */
export function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function shift(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The official Dutch public holidays of one year.
 *   * King's Day moves to 26 April when 27 April is a Sunday.
 *   * Good Friday and Liberation Day are on the official list, but not every
 *     school or employer is closed; mark them as a school day if yours isn't.
 */
export function dutchPublicHolidays(year: number): OverrideRow[] {
  const easter = easterSunday(year);
  const kingsDay = new Date(`${year}-04-27T12:00:00Z`).getUTCDay() === 0 ? `${year}-04-26` : `${year}-04-27`;

  const days: Array<[string, string]> = [
    [`${year}-01-01`, "New Year's Day"],
    [shift(easter, -2), "Good Friday"],
    [easter, "Easter Sunday"],
    [shift(easter, 1), "Easter Monday"],
    [kingsDay, "King's Day"],
    [`${year}-05-05`, "Liberation Day"],
    [shift(easter, 39), "Ascension Day"],
    [shift(easter, 49), "Whit Sunday"],
    [shift(easter, 50), "Whit Monday"],
    [`${year}-12-25`, "Christmas Day"],
    [`${year}-12-26`, "Boxing Day"],
  ];

  return days.map(([date, name]) => ({
    start_date: date,
    end_date: date,
    kind: "public_holiday" as const,
    name,
    source: "computed" as const,
    external_key: `public:${date}:${name.toLowerCase().replace(/[^a-z]+/g, "-")}`,
  }));
}
