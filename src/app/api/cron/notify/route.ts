/**
 * POST /api/cron/notify   (called every 5 minutes by Supabase pg_cron)
 *
 * The caller must send `Authorization: Bearer <secret>`, where the secret is
 * the one pg_cron reads from Supabase Vault. The route asks the database to
 * compare it (notify_check_secret), so the secret is never copied to Vercel.
 */
import { NextResponse, type NextRequest } from "next/server";
import { syncStaleBudgets } from "@/lib/bunq/sync";
import { runNotifications } from "@/lib/notify/run";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: NextRequest) {
  // Step 1: only the database job may run this.
  const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  const { data: ok } = token
    ? await getSupabaseAdminClient().rpc("notify_check_secret", { p_secret: token })
    : { data: false };
  if (!ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // Step 2: send whatever is due, then refresh grocery budgets not synced
  //         in the last hour (riding on the same job keeps it to one cron).
  try {
    const notifications = await runNotifications();
    const budgets = await syncStaleBudgets(60).catch((err) => {
      console.error("[bunq] stale sync failed", err);
      return 0;
    });
    return NextResponse.json({ ...notifications, budgets });
  } catch (err) {
    console.error("[notify] run failed", err);
    return NextResponse.json({ error: "notify_failed" }, { status: 500 });
  }
}
