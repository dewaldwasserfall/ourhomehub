/**
 * GET /api/bunq/oauth/callback?code=...&state=...
 *
 * bunq sends the owner back here after approving HomeHub. We check the state,
 * swap the code for an access token, set up the API context (key pair,
 * installation, device registration) and keep it all in Supabase Vault.
 * Then on to the budget settings to choose the groceries account.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createApiContext, exchangeBunqCode } from "@/lib/bunq/api";
import { getCaller } from "@/lib/calendar/caller";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(request: NextRequest) {
  const origin = request.nextUrl.origin;
  const done = (status: string) => {
    const response = NextResponse.redirect(`${origin}/budget/settings?bunq=${status}`);
    response.cookies.delete({ name: "bunq_oauth_state", path: "/api/bunq/oauth" });
    return response;
  };

  // Step 1: still the owner, and the state matches the cookie.
  const result = await getCaller({ ownerOnly: true });
  if (!result.ok) return done("owner_only");
  const { searchParams } = request.nextUrl;
  const state = searchParams.get("state");
  if (!state || state !== request.cookies.get("bunq_oauth_state")?.value) return done("state_mismatch");
  const code = searchParams.get("code");
  if (!code) return done("cancelled");

  try {
    // Step 2: code -> access token -> API context.
    const accessToken = await exchangeBunqCode(code, `${origin}/api/bunq/oauth/callback`);
    const credentials = await createApiContext(accessToken);

    // Step 3: into Vault (the RPC also creates or reactivates the connection).
    const { error } = await getSupabaseAdminClient().rpc("bunq_save_credentials", {
      p_household_id: result.caller.householdId,
      p_credentials: JSON.stringify(credentials),
      p_connected_by: result.caller.memberId,
    });
    if (error) throw new Error(error.message);
    return done("connected");
  } catch (err) {
    console.error("[bunq] connect failed", err);
    return done("failed");
  }
}
