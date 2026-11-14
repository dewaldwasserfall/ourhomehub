/**
 * POST /api/appliances/connect   { apiKey, accessToken, refreshToken }
 *
 * Connects the AEG dishwasher (owner only). The three values come from
 * developer.electrolux.one; they travel to this server once, are checked
 * against Electrolux, and are kept in Vault. They're never stored in the
 * browser or shown again.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getCaller, jsonError } from "@/lib/calendar/caller";
import { listAppliances, refreshTokens, tokenFresh, type ElectroluxCredentials } from "@/lib/electrolux/api";
import { pollAppliance, saveCredentials } from "@/lib/electrolux/poll";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: NextRequest) {
  // Step 1: owners only; three non-empty strings.
  const result = await getCaller({ ownerOnly: true });
  if (!result.ok) return result.response;
  const body = (await request.json().catch(() => null)) as Partial<Record<keyof ElectroluxCredentials, unknown>> | null;
  const value = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  let credentials: ElectroluxCredentials = {
    apiKey: value(body?.apiKey),
    accessToken: value(body?.accessToken),
    refreshToken: value(body?.refreshToken),
  };
  if (!credentials.apiKey || !credentials.refreshToken) {
    return jsonError(400, "missing", "Paste the API key and the refresh token (the access token too, if you have it).");
  }

  try {
    // Step 2: a usable access token (refresh if it's missing or old).
    if (!credentials.accessToken || !tokenFresh(credentials.accessToken)) credentials = await refreshTokens(credentials);

    // Step 3: find the dishwasher on this account.
    const appliances = await listAppliances(credentials);
    const dishwasher = appliances.find((a) => a.applianceType === "DW");
    if (!dishwasher) {
      return jsonError(404, "no_dishwasher", "No dishwasher found on this Electrolux account. Check it shows in the My AEG app.");
    }

    // Step 4: keep the credentials, remember the appliance, read its state once.
    const householdId = result.caller.householdId;
    await saveCredentials(householdId, credentials, result.caller.memberId);
    await getSupabaseAdminClient()
      .from("appliance_connections")
      .update({ appliance_id: dishwasher.applianceId, appliance_name: dishwasher.applianceName, appliance_type: dishwasher.applianceType })
      .eq("household_id", householdId);
    await pollAppliance(householdId).catch((err) => console.warn("[dishwasher] first poll failed", err));
    return NextResponse.json({ ok: true, name: dishwasher.applianceName });
  } catch (err) {
    console.error("[dishwasher] connect failed", err);
    return jsonError(400, "connect_failed", "Electrolux didn't accept those details. Make a fresh token on developer.electrolux.one and try again.");
  }
}
