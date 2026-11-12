/**
 * POST /api/calendar/webhook
 *
 * Google calls this whenever the family calendar changes. Public (Google has
 * no session), so every request is checked against the channel id and the
 * secret token we registered; anything else is ignored.
 *
 * Headers Google sends:
 *   X-Goog-Channel-ID      our channel id
 *   X-Goog-Channel-Token   our secret token
 *   X-Goog-Resource-State  "sync" (first ping after registering) or "exists"
 */
import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { syncHousehold } from "@/lib/calendar/sync";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 60;

function sameSecret(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export async function POST(request: NextRequest) {
  const channelId = request.headers.get("x-goog-channel-id");
  const token = request.headers.get("x-goog-channel-token");
  const state = request.headers.get("x-goog-resource-state");

  // Step 1: identify the household by channel and verify the secret.
  if (!channelId || !token) return new NextResponse(null, { status: 204 });
  const { data: connection } = await getSupabaseAdminClient()
    .from("calendar_connections")
    .select("household_id, channel_token")
    .eq("channel_id", channelId)
    .maybeSingle<{ household_id: string; channel_token: string | null }>();
  if (!connection?.channel_token || !sameSecret(connection.channel_token, token)) {
    return new NextResponse(null, { status: 204 });
  }

  // Step 2: the first "sync" ping only confirms the channel works.
  if (state === "sync") return new NextResponse(null, { status: 200 });

  // Step 3: pull the changes. Always answer 200 so Google doesn't retry in a loop.
  try {
    await syncHousehold(connection.household_id);
  } catch (err) {
    console.error("[calendar] webhook sync failed", err);
  }
  return new NextResponse(null, { status: 200 });
}
