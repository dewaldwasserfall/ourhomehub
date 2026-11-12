/**
 * GET /api/calendar/oauth/callback
 *
 * Google sends the owner back here after they approve calendar access.
 *   1. Check the state cookie (blocks forged callbacks)
 *   2. Swap the code for tokens; read which Google account approved
 *   3. Store the refresh token in Vault and the connection row
 *   4. Full sync, then register the push channel
 *   5. Back to the Household tab with the result
 */
import { NextResponse, type NextRequest } from "next/server";
import { getCaller } from "@/lib/calendar/caller";
import { ensureChannel, syncHousehold } from "@/lib/calendar/sync";
import { emailFromIdToken, exchangeCode } from "@/lib/google/oauth";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const { origin, searchParams } = request.nextUrl;
  const back = (outcome: string) => {
    const res = NextResponse.redirect(`${origin}/household?calendar=${outcome}`);
    res.cookies.delete({ name: "calendar_oauth_state", path: "/api/calendar/oauth" });
    return res;
  };

  // Step 1: cancelled on Google's screen, or a state mismatch.
  if (searchParams.get("error")) return back("cancelled");
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const expected = request.cookies.get("calendar_oauth_state")?.value;
  if (!code || !state || !expected || state !== expected) return back("failed");

  // Step 1b: still the signed-in owner?
  const result = await getCaller({ ownerOnly: true });
  if (!result.ok) return back("owner_only");
  const { caller } = result;

  try {
    // Step 2: tokens + which account approved.
    const tokens = await exchangeCode(code, `${origin}/api/calendar/oauth/callback`);
    if (!tokens.refresh_token) return back("no_refresh_token");
    if (!tokens.scope?.includes("calendar.events")) return back("missing_permission");
    const email = emailFromIdToken(tokens.id_token);
    if (!email) return back("failed");

    // Step 3: store. The account's primary calendar id is its email address.
    const { error } = await getSupabaseAdminClient().rpc("calendar_save_connection", {
      p_household_id: caller.householdId,
      p_google_email: email,
      p_calendar_id: email,
      p_refresh_token: tokens.refresh_token,
      p_connected_by: caller.memberId,
    });
    if (error) throw new Error(error.message);

    // Step 4: first full sync, then live updates.
    await syncHousehold(caller.householdId, { full: true });
    await ensureChannel(caller.householdId, { force: true }).catch((err) => {
      // Sync still works without push (daily job + manual refresh); log and continue.
      console.error("[calendar] watch failed", err);
    });

    return back("connected");
  } catch (err) {
    console.error("[calendar] connect failed", err);
    return back("failed");
  }
}
