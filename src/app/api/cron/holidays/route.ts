/**
 * GET /api/cron/holidays   (Vercel Cron, weekly; see vercel.json)
 *
 * Refreshes school and public holidays for every household, so next school
 * year's holidays appear as soon as the government publishes them.
 * Vercel sends `Authorization: Bearer <CRON_SECRET>`; anything else is refused.
 */
import { NextResponse, type NextRequest } from "next/server";
import { importHolidays } from "@/lib/holidays-import";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  // Step 0: only Vercel Cron may run this.
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Step 1: every household, one at a time.
  const { data: households } = await getSupabaseAdminClient().from("households").select("id");
  const results: Array<{ household: string; ok: boolean; error?: string }> = [];
  for (const { id } of (households ?? []) as Array<{ id: string }>) {
    try {
      await importHolidays(id);
      results.push({ household: id, ok: true });
    } catch (err) {
      console.error("[holidays] cron failed for", id, err);
      results.push({ household: id, ok: false, error: String(err).slice(0, 200) });
    }
  }
  return NextResponse.json({ ran: results.length, results });
}
