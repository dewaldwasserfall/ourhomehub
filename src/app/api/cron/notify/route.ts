/**
 * POST /api/cron/notify   (called every 5 minutes by Supabase pg_cron)
 *
 * The caller must send `Authorization: Bearer <secret>`, where the secret is
 * the one pg_cron reads from Supabase Vault. The route asks the database to
 * compare it (notify_check_secret), so the secret is never copied to Vercel.
 *
 * Also rides along: grocery budget sync, SmartThings token refresh and
 * pruning old device events (one cron job for all of them).
 */
import { NextResponse, type NextRequest } from "next/server";
import { syncStaleBudgets } from "@/lib/bunq/sync";
import { runNotifications } from "@/lib/notify/run";
import { refreshDueTokens } from "@/lib/smartthings/sync";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: NextRequest) {
  // Step 1: only the database job may run this.
  const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  const admin = getSupabaseAdminClient();
  const { data: ok } = token
    ? await admin.rpc("notify_check_secret", { p_secret: token })
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
    // SmartThings tokens last 24 hours: refresh the ones running out soon,
    // and forget device events older than 30 days.
    const smartthings = await refreshDueTokens().catch((err) => {
      console.error("[smartthings] token refresh failed", err);
      return 0;
    });
    await admin.rpc("home_prune_events").then(undefined, () => undefined);
    return NextResponse.json({ ...notifications, budgets, smartthings });
  } catch (err) {
    console.error("[notify] run failed", err);
    return NextResponse.json({ error: "notify_failed" }, { status: 500 });
  }
}
