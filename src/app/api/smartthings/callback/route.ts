/**
 * GET /api/smartthings/callback?code=...&state=...
 *
 * Samsung sends the owner back here after approving HomeHub for a home. We
 * check the state, swap the code for tokens, keep them in Vault, read the
 * devices and turn on live updates (if the app's Target URL is confirmed).
 */
import { NextResponse, type NextRequest } from "next/server";
import { getCaller } from "@/lib/calendar/caller";
import { exchangeCode } from "@/lib/smartthings/api";
import { saveCredentials, syncDevices } from "@/lib/smartthings/sync";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(request: NextRequest) {
  const origin = request.nextUrl.origin;
  const done = (status: string) => {
    const response = NextResponse.redirect(`${origin}/household/home?st=${status}`);
    response.cookies.delete({ name: "st_oauth_state", path: "/api/smartthings" });
    return response;
  };

  // Step 1: still the owner, and the state matches the cookie.
  const result = await getCaller({ ownerOnly: true });
  if (!result.ok) return done("owner_only");
  const { searchParams } = request.nextUrl;
  const state = searchParams.get("state");
  if (!state || state !== request.cookies.get("st_oauth_state")?.value) return done("state_mismatch");
  const code = searchParams.get("code");
  if (!code) return done("cancelled");

  try {
    // Step 2: code -> tokens -> Vault.
    const credentials = await exchangeCode(code, `${origin}/api/smartthings/callback`);
    await saveCredentials(result.caller.householdId, credentials, result.caller.memberId);

    // Step 3: devices, and live updates if SmartThings will send them.
    await syncDevices(result.caller.householdId, { subscribe: true });
    return done("connected");
  } catch (err) {
    console.error("[smartthings] connect failed", err);
    return done("failed");
  }
}
