/**
 * POST /api/cron/notify   (called every 5 minutes by Supabase pg_cron)
 *
 * The caller must send `Authorization: Bearer <secret>`, where the secret is
 * the one pg_cron reads from Supabase Vault. The route asks the database to
 * compare it (notify_check_secret), so the secret is never copied to Vercel.
 *
 * Also rides along: grocery budget sync, SmartThings token refresh, pruning
 * old device events, checking the dishwasher and moving children's missed
 * chores on to their next day (one cron job for all).
 */
import { NextResponse, type NextRequest } from "next/server";
import { syncStaleBudgets } from "@/lib/bunq/sync";
import { runNotifications } from "@/lib/notify/run";
import { pollDueAppliances } from "@/lib/electrolux/poll";
import { refreshDueTokens } from "@/lib/smartthings/sync";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 30;

/** Each household's children's missed chores → their next day. */
async function rollMissedChores(admin: ReturnType<typeof getSupabaseAdminClient>): Promise<number> {
  const { data: households } = await admin.from("households").select("id");
  let moved = 0;
  for (const h of (households ?? []) as Array<{ id: string }>) {
    const { data } = await admin.rpc("roll_missed_chores", { p_household_id: h.id });
    moved += typeof data === "number" ? data : 0;
  }
  return moved;
}

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

    // The dishwasher: read its state (countdown on Today) and add "Empty
    // the dishwasher" when a run has just finished.
    const appliances = await pollDueAppliances().catch((err) => {
      console.error("[dishwasher] poll failed", err);
      return 0;
    });
    // Missed, not late: a child's repeating chore that wasn't done moves on
    // to its next scheduled day (see roll_missed_chores).
    const rolled = await rollMissedChores(admin).catch((err) => {
      console.error("[chores] roll missed failed", err);
      return 0;
    });
    return NextResponse.json({ ...notifications, budgets, smartthings, appliances, rolled });
  } catch (err) {
    console.error("[notify] run failed", err);
    return NextResponse.json({ error: "notify_failed" }, { status: 500 });
  }
}
