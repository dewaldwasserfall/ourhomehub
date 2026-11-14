/**
 * Vault documents (passports, ID cards, driving licences): pure helpers for
 * expiry warnings and reminders. HomeHub only knows the expiry date, the
 * details printed on the document and the 1Password link; the numbers, BSN
 * and scans stay in 1Password.
 *
 *   * idLabel()          – "Passport (Netherlands)"
 *   * expiryStatus()     – expired / under 6 months / fine
 *   * tripIdWarnings()   – people going whose document runs out before, or
 *                          within 6 months after, the trip's last day
 *   * idReminder()       – the push reminder at 6, 3 and 1 month(s) before
 */
import { addDays, daysBetweenKeys } from "./calendar/time";
import type { MemberId, Trip, TripParticipant } from "./types";

const SIX_MONTHS_DAYS = 183;

/** Display names per kind ("Rijbewijs" is what the family calls it). */
export const KIND_LABELS: Record<MemberId["kind"], string> = {
  passport: "Passport",
  id_card: "ID card",
  drivers_license: "Rijbewijs",
};

/** Passports and ID cards count for travel; a driving licence doesn't. */
export const isTravelDocument = (id: Pick<MemberId, "kind">) => id.kind !== "drivers_license";

export const idLabel = (id: Pick<MemberId, "kind" | "country">) => `${KIND_LABELS[id.kind]}${id.country ? ` (${id.country})` : ""}`;

const longDate = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
export const expiryText = (date: string) => longDate.format(new Date(`${date}T12:00:00Z`));

// -----------------------------------------------------------------------------
// Step 1: how soon does it run out?
// -----------------------------------------------------------------------------

export type ExpiryStatus = { state: "expired" | "soon" | "ok"; daysLeft: number };

/** "soon" = within 6 months (many countries want 6 months left on arrival). */
export function expiryStatus(id: Pick<MemberId, "expiry_date">, today: string): ExpiryStatus {
  const daysLeft = daysBetweenKeys(today, id.expiry_date);
  return { state: daysLeft < 0 ? "expired" : daysLeft <= SIX_MONTHS_DAYS ? "soon" : "ok", daysLeft };
}

// -----------------------------------------------------------------------------
// Step 2: warnings for a trip
// -----------------------------------------------------------------------------

export interface TripIdWarning {
  memberId: string;
  id: MemberId | null;
  /** "missing": no passport or ID recorded for them. */
  problem: "expires_during" | "under_six_months" | "missing";
}

/**
 * For each person going: their documents compared with the trip's last day.
 * Expires before the end -> "expires_during"; less than 6 months left after
 * the trip -> "under_six_months". Someone with several documents is fine if
 * any one is fine. Nobody recorded -> "missing" (only when anyone in the
 * household has a document recorded, so a fresh setup isn't all warnings).
 */
export function tripIdWarnings(trip: Pick<Trip, "end_date">, participants: TripParticipant[], ids: MemberId[]): TripIdWarning[] {
  // Only travel documents matter here (a rijbewijs doesn't get you across a border).
  ids = ids.filter(isTravelDocument);
  if (ids.length === 0) return [];
  const sixMonthsAfter = addDays(trip.end_date, SIX_MONTHS_DAYS);
  const warnings: TripIdWarning[] = [];
  for (const p of participants) {
    const theirs = ids.filter((i) => i.member_id === p.member_id).sort((a, b) => b.expiry_date.localeCompare(a.expiry_date));
    if (theirs.length === 0) {
      warnings.push({ memberId: p.member_id, id: null, problem: "missing" });
      continue;
    }
    const best = theirs[0];
    if (best.expiry_date < trip.end_date) warnings.push({ memberId: p.member_id, id: best, problem: "expires_during" });
    else if (best.expiry_date < sixMonthsAfter) warnings.push({ memberId: p.member_id, id: best, problem: "under_six_months" });
  }
  return warnings;
}

// -----------------------------------------------------------------------------
// Step 3: the reminder (sent once at each step)
// -----------------------------------------------------------------------------

const STEPS = [
  { days: SIX_MONTHS_DAYS, label: "in 6 months" },
  { days: 91, label: "in 3 months" },
  { days: 30, label: "in a month" },
];

/**
 * The reminder due for this document today, if any: the smallest step it
 * has reached (so a document added with 2 months left gets the 3-month one,
 * once). The key makes each step send once per person.
 */
export function idReminder(
  id: MemberId,
  name: string,
  today: string,
): { key: string; title: string; body: string; url: string } | null {
  const daysLeft = daysBetweenKeys(today, id.expiry_date);
  if (daysLeft < 0) return null;
  const step = [...STEPS].reverse().find((s) => daysLeft <= s.days);
  if (!step) return null;
  return {
    key: `id:${id.id}:${id.expiry_date}:${step.days}`,
    title: `${name}'s ${id.kind === "id_card" ? "ID card" : KIND_LABELS[id.kind].toLowerCase()} expires ${step.label}`,
    body: `${idLabel(id)} · ${expiryText(id.expiry_date)}. Renewing can take a few weeks.`,
    url: "/vault",
  };
}
