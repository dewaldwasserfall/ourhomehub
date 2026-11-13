/**
 * Copy the groceries account's payments from bunq into bunq_payments.
 * SERVER ONLY (service-role client, Vault credentials).
 *
 * Runs from the 5-minute job at most once an hour per household, and when
 * someone taps "Update now". Keeps this budget month and the two before it.
 */
import { budgetPeriod, classifyPayment, shopKey } from "../budget";
import { dateKey } from "../calendar/time";
import { getSupabaseAdminClient } from "../supabase/admin";
import { BunqError, listAccounts, listPayments, openSession, type BunqCredentials, type BunqSession } from "./api";

interface ConnectionRow {
  household_id: string;
  account_id: number | null;
  period_start_day: number;
  last_synced_at: string | null;
}

/** Step 1: credentials from Vault, and a session. */
export async function sessionFor(householdId: string): Promise<BunqSession> {
  const { data } = await getSupabaseAdminClient().rpc("bunq_get_credentials", { p_household_id: householdId });
  if (!data) throw new BunqError("bunq isn't connected", 404);
  return openSession(JSON.parse(data as string) as BunqCredentials);
}

/** Step 2: sync one household. Returns the number of payments stored. */
export async function syncBudget(householdId: string): Promise<number> {
  const admin = getSupabaseAdminClient();
  const [{ data: conn }, { data: household }] = await Promise.all([
    admin
      .from("bunq_connections")
      .select("household_id, account_id, period_start_day, last_synced_at")
      .eq("household_id", householdId)
      .single<ConnectionRow>(),
    admin.from("households").select("timezone").eq("id", householdId).single<{ timezone: string }>(),
  ]);
  if (!conn?.account_id) return 0; // connected, but no account chosen yet

  try {
    // 2a. How far back: the start of the budget month two months before
    //     this one (so this month and the two before it are kept).
    const today = dateKey(new Date(), household?.timezone ?? "Europe/Amsterdam");
    const [y, m] = budgetPeriod(today, conn.period_start_day).start.split("-").map(Number);
    const since = new Date(Date.UTC(y, m - 3, conn.period_start_day)).toISOString();

    // 2b. Read from bunq.
    const session = await sessionFor(householdId);
    const [payments, accounts] = await Promise.all([listPayments(session, conn.account_id, since), listAccounts(session)]);

    // 2c. Store (upsert by bunq id), classified. Every run re-saves the
    //     whole window, so a change to the rules fixes older rows too.
    //     Money in is a refund only from somewhere this account has paid.
    const paidTo = new Set(payments.filter((p) => p.amountCents < 0).map((p) => shopKey(p.counterparty)).filter(Boolean));
    const rows = payments.map((p) => ({
      id: p.id,
      household_id: householdId,
      created_at: p.createdAt,
      amount_cents: p.amountCents,
      counterparty: p.counterparty,
      description: p.description,
      kind: classifyPayment(p.amountCents, p.counterparty, paidTo),
    }));
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await admin.from("bunq_payments").upsert(rows.slice(i, i + 500));
      if (error) throw new Error(error.message);
    }

    // 2d. Forget payments older than the window.
    await admin.from("bunq_payments").delete().eq("household_id", householdId).lt("created_at", since);

    const account = accounts.find((a) => a.id === conn.account_id);
    await admin
      .from("bunq_connections")
      .update({
        last_synced_at: new Date().toISOString(),
        status: "active",
        last_error: null,
        balance_cents: account?.balanceCents ?? null,
      })
      .eq("household_id", householdId);
    return rows.length;
  } catch (err) {
    // 2e. Record the problem for the settings screen (a revoked approval
    //     shows as 401/403: reconnect).
    const status = err instanceof BunqError ? err.status : 0;
    const message =
      status === 401 || status === 403
        ? "bunq no longer accepts HomeHub's access. Connect again."
        : String(err instanceof Error ? err.message : err).slice(0, 300);
    await admin.from("bunq_connections").update({ status: "error", last_error: message }).eq("household_id", householdId);
    throw err;
  }
}

/** Step 3: for the 5-minute job, sync households not synced in the last hour. */
export async function syncStaleBudgets(maxAgeMinutes = 60): Promise<number> {
  const admin = getSupabaseAdminClient();
  const cutoff = new Date(Date.now() - maxAgeMinutes * 60_000).toISOString();
  const { data } = await admin
    .from("bunq_connections")
    .select("household_id")
    .not("account_id", "is", null)
    .or(`last_synced_at.is.null,last_synced_at.lt.${cutoff}`);
  let synced = 0;
  for (const { household_id } of (data ?? []) as Array<{ household_id: string }>) {
    try {
      await syncBudget(household_id);
      synced++;
    } catch (err) {
      console.error("[bunq] sync failed", household_id, err);
    }
  }
  return synced;
}
