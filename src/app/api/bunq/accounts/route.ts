/**
 * GET /api/bunq/accounts
 *
 * The owner's active bunq accounts, to choose which one is for groceries.
 */
import { NextResponse } from "next/server";
import { listAccounts } from "@/lib/bunq/api";
import { sessionFor } from "@/lib/bunq/sync";
import { getCaller, jsonError } from "@/lib/calendar/caller";

export const runtime = "nodejs";

export async function GET() {
  const result = await getCaller({ ownerOnly: true });
  if (!result.ok) return result.response;
  try {
    const accounts = await listAccounts(await sessionFor(result.caller.householdId));
    return NextResponse.json({ accounts });
  } catch (err) {
    console.error("[bunq] accounts failed", err);
    return jsonError(502, "bunq_failed", "Couldn't reach bunq. Try again, or connect again.");
  }
}
