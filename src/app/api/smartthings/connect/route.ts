/**
 * GET /api/smartthings/connect
 *
 * Starts connecting SmartThings (owner only): a one-time state cookie
 * against forged callbacks, then off to Samsung to sign in and pick the home.
 */
import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { getCaller } from "@/lib/calendar/caller";
import { buildAuthUrl, smartThingsConfig } from "@/lib/smartthings/api";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const origin = request.nextUrl.origin;

  // Step 1: owners only, and the app must be registered (Vercel env).
  const result = await getCaller({ ownerOnly: true });
  if (!result.ok) return NextResponse.redirect(`${origin}/household/home?st=owner_only`);
  const config = smartThingsConfig();
  if (!config) return NextResponse.redirect(`${origin}/household/home?st=not_set_up`);

  // Step 2: random state in an httpOnly cookie for 10 minutes, then to Samsung.
  const state = randomBytes(24).toString("base64url");
  const response = NextResponse.redirect(buildAuthUrl(config.clientId, `${origin}/api/smartthings/callback`, state));
  response.cookies.set("st_oauth_state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/api/smartthings",
    maxAge: 600,
  });
  return response;
}
