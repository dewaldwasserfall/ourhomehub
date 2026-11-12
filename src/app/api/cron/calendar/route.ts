/**
 * GET /api/cron/calendar   (Vercel Cron, daily; see vercel.json)
 *
 * For every connected household:
 *   1. renew the push channel if it expires within 48 hours
 *   2. run an incremental sync, in case a notification was missed
 *
 * Vercel sends `Authorization: Bearer <CRON_SECRET>`; anything else is refused.
 */
import { NextResponse, type NextRequest } from "next/server";
import { ensureChannel, syncHousehold } from "@/lib/calendar/sync";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  // Step 0: only Vercel Cron may run this.
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { data: connections } = await getSupabaseAdminClient().from("calendar_connections").select("household_id");
  const results: Array<{ household: string; ok: boolean; error?: string }> = [];

  for (const { household_id } of (connections ?? []) as Array<{ household_id: string }>) {
    try {
      // Steps 1 and 2.
      await ensureChannel(household_id);
      await syncHousehold(household_id);
      results.push({ household: household_id, ok: true });
    } catch (err) {
      console.error("[calendar] cron failed for", household_id, err);
      results.push({ household: household_id, ok: false, error: String(err).slice(0, 200) });
    }
  }
  return NextResponse.json({ ran: results.length, results });
}
