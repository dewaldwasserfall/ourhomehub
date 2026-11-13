/**
 * POST /api/notify/test
 *
 * Sends "Notifications are on" to the signed-in person's own devices, so they
 * can check it works right after turning it on.
 */
import { NextResponse } from "next/server";
import { getCaller, jsonError } from "@/lib/calendar/caller";
import { sendToDevices } from "@/lib/notify/run";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

export async function POST() {
  // Step 1: who is asking.
  const result = await getCaller();
  if (!result.ok) return result.response;

  // Step 2: their devices only.
  const { data } = await getSupabaseAdminClient()
    .from("push_subscriptions")
    .select("id, member_id, endpoint, p256dh, auth")
    .eq("member_id", result.caller.memberId);
  if (!data?.length) return jsonError(409, "no_devices", "Turn notifications on for this phone first.");

  // Step 3: send.
  try {
    const reached = await sendToDevices(data, {
      key: "test",
      title: "Notifications are on",
      body: "This is how HomeHub reminders will look.",
      url: "/household/notifications",
    });
    return NextResponse.json({ reached });
  } catch (err) {
    console.error("[notify] test failed", err);
    return jsonError(500, "notify_failed", "Couldn't send the test. Try again in a moment.");
  }
}
