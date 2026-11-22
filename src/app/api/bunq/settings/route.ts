/**
 * POST /api/bunq/settings   { accountId?, accountLabel?, periodStartDay?, passthroughFrom?, passthroughTo? }
 *
 * passthroughFrom / passthroughTo: names (e.g. ["Belastingdienst"], ["Dewald"])
 * of money that only passes through the account; stored as typed, and the
 * next sync reclassifies the payments.
 *
 * The owner chooses the groceries account and sets the budget. Choosing a
 * different account clears the copied payments and syncs again.
 */
import { NextResponse, type NextRequest } from "next/server";
import { shopKey } from "@/lib/budget";
import { syncBudget } from "@/lib/bunq/sync";
import { getCaller, jsonError } from "@/lib/calendar/caller";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: NextRequest) {
  // Step 1: owner only.
  const result = await getCaller({ ownerOnly: true });
  if (!result.ok) return result.response;
  const householdId = result.caller.householdId;

  // Step 2: validate what was sent.
  const body = (await request.json().catch(() => ({}))) as {
    accountId?: number;
    accountLabel?: string;
    periodStartDay?: number;
    passthroughFrom?: unknown;
    passthroughTo?: unknown;
  };
  const update: Record<string, unknown> = {};
  if (body.accountId !== undefined) {
    if (!Number.isInteger(body.accountId) || body.accountId <= 0) return jsonError(400, "invalid", "Choose an account.");
    update.account_id = body.accountId;
    update.account_label = String(body.accountLabel ?? "").slice(0, 80) || null;
  }
  if (body.periodStartDay !== undefined) {
    if (!Number.isInteger(body.periodStartDay) || body.periodStartDay < 1 || body.periodStartDay > 28)
      return jsonError(400, "invalid", "The month can start on day 1 to 28.");
    update.period_start_day = body.periodStartDay;
  }

  // 2b. The pass-through rule: up to 10 names each, kept as typed (the
  //     sync compares them by shopKey, so "Anél" still reads "Anél" here).
  const keys = (v: unknown) =>
    Array.isArray(v)
      ? [...new Map(v.map((x) => String(x).trim().slice(0, 80)).filter((x) => shopKey(x)).map((x) => [shopKey(x), x])).values()].slice(0, 10)
      : null;
  const from = keys(body.passthroughFrom);
  const to = keys(body.passthroughTo);
  if (from) update.passthrough_from = from;
  if (to) update.passthrough_to = to;
  if (from || to) update.last_synced_at = null; // reclassify on the next sync

  // Step 3: save; a new account starts from a clean copy.
  const admin = getSupabaseAdminClient();
  const { data: before } = await admin.from("bunq_connections").select("account_id").eq("household_id", householdId).single<{ account_id: number | null }>();
  if (!before) return jsonError(404, "not_connected", "Connect bunq first.");
  const { error } = await admin.from("bunq_connections").update(update).eq("household_id", householdId);
  if (error) return jsonError(500, "save_failed", "Couldn't save the budget settings.");

  // A changed rule: sync now so the overview is right straight away.
  if ((from || to) && !update.account_id) {
    try {
      await syncBudget(householdId);
    } catch {
      // Recorded on the connection; the next run tries again.
    }
  }

  if (update.account_id && update.account_id !== before.account_id) {
    await admin.from("bunq_payments").delete().eq("household_id", householdId);
    try {
      await syncBudget(householdId);
    } catch {
      // The error is recorded on the connection; the screen shows it.
    }
  }
  return NextResponse.json({ ok: true });
}
