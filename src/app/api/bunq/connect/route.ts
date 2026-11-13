/**
 * GET /api/bunq/connect
 *
 * Starts connecting bunq (owner only): a one-time state cookie against forged
 * callbacks, then off to bunq to approve HomeHub in the bunq app.
 */
import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { buildBunqAuthUrl } from "@/lib/bunq/api";
import { getCaller } from "@/lib/calendar/caller";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const origin = request.nextUrl.origin;

  // Step 1: owners only.
  const result = await getCaller({ ownerOnly: true });
  if (!result.ok) return NextResponse.redirect(`${origin}/budget?bunq=owner_only`);

  // Step 2: random state in an httpOnly cookie for 10 minutes, then to bunq.
  const state = randomBytes(24).toString("base64url");
  const response = NextResponse.redirect(buildBunqAuthUrl(`${origin}/api/bunq/oauth/callback`, state));
  response.cookies.set("bunq_oauth_state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/api/bunq/oauth",
    maxAge: 600,
  });
  return response;
}
