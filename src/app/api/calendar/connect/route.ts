/**
 * GET /api/calendar/connect
 *
 * Starts connecting the family calendar (owner only): sets a one-time state
 * cookie against forged callbacks, then sends the owner to Google's consent
 * screen with the family account pre-selected.
 */
import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { buildConsentUrl } from "@/lib/google/oauth";
import { getCaller } from "@/lib/calendar/caller";

export const runtime = "nodejs";

/** The shared family calendar this household syncs. */
const FAMILY_ACCOUNT_HINT = process.env.FAMILY_CALENDAR_ACCOUNT ?? "wasserfallfamilie@gmail.com";

export async function GET(request: NextRequest) {
  const origin = request.nextUrl.origin;

  // Step 1: owners only. Others are sent back to the Household tab.
  const result = await getCaller({ ownerOnly: true });
  if (!result.ok) return NextResponse.redirect(`${origin}/household?calendar=owner_only`);

  // Step 2: a random state, remembered in an httpOnly cookie for 10 minutes.
  const state = randomBytes(24).toString("base64url");
  const response = NextResponse.redirect(
    buildConsentUrl(`${origin}/api/calendar/oauth/callback`, state, FAMILY_ACCOUNT_HINT),
  );
  response.cookies.set("calendar_oauth_state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/api/calendar/oauth",
    maxAge: 600,
  });
  return response;
}
