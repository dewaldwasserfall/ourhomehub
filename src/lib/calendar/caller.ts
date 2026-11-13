/**
 * Who is calling a calendar API route, and are they allowed?
 *
 * Uses the caller's own session (not the service key), so the allowlist,
 * Jana's end date and household membership are all enforced by the same
 * database rules as everywhere else.
 */
import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export interface Caller {
  userId: string;
  memberId: string;
  householdId: string;
  isOwner: boolean;
  /** Owners and adults; children may only read and tick their own things. */
  isAdult: boolean;
  timeZone: string;
}

export type CallerResult = { ok: true; caller: Caller } | { ok: false; response: NextResponse };

export function jsonError(status: number, code: string, message: string) {
  return NextResponse.json({ error: code, message }, { status });
}

export async function getCaller(opts: { ownerOnly?: boolean; adultOnly?: boolean } = {}): Promise<CallerResult> {
  const supabase = await getSupabaseServerClient();

  // Step 1: signed in?
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, response: jsonError(401, "not_authenticated", "Your session ended. Sign in again.") };

  // Step 2: an active household member? (current_household_id() also checks
  // the allowlist and its end date)
  const { data: householdId } = await supabase.rpc("current_household_id");
  if (!householdId) {
    return { ok: false, response: jsonError(403, "not_in_household", "This account doesn't have access to the household.") };
  }

  // Step 3: their member row and the household's time zone.
  const [{ data: member }, { data: household }] = await Promise.all([
    supabase.from("members").select("id, role").eq("user_id", user.id).single<{ id: string; role: string }>(),
    supabase.from("households").select("timezone").eq("id", householdId).single<{ timezone: string }>(),
  ]);
  if (!member) return { ok: false, response: jsonError(403, "not_in_household", "This account doesn't have access to the household.") };

  const caller: Caller = {
    userId: user.id,
    memberId: member.id,
    householdId: householdId as string,
    isOwner: member.role === "owner",
    isAdult: member.role === "owner" || member.role === "adult",
    timeZone: household?.timezone ?? "Europe/Amsterdam",
  };

  // Step 4: owner-only actions (connecting / disconnecting the calendar).
  if (opts.ownerOnly && !caller.isOwner) {
    return { ok: false, response: jsonError(403, "owner_only", "Only the household owner can change the calendar connection.") };
  }
  // Step 5: adult-only actions (calendar changes, holiday import).
  if (opts.adultOnly && !caller.isAdult) {
    return { ok: false, response: jsonError(403, "adults_only", "Ask a parent to make this change.") };
  }
  return { ok: true, caller };
}
