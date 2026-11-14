/**
 * POST /api/smartthings/webhook   (SmartThings calls this; public route)
 *
 * The app's Target URL. SmartThings sends three kinds of calls:
 *
 *   CONFIRMATION  once, after the Target URL is set: we open the
 *                 confirmation link to prove we own this URL
 *   PING          "are you there": we echo the challenge
 *   EVENT         device changes we subscribed to: each one updates the
 *                 device's state and goes into home_events (only real
 *                 changes; see home_record_event)
 *   UNINSTALL     HomeHub was removed in the SmartThings app: forget the
 *                 connection, devices and events
 *
 * EVENT and UNINSTALL calls must carry a valid SmartThings signature.
 */
import { NextResponse, type NextRequest } from "next/server";
import { isSmartThingsUrl, verifySmartThingsRequest } from "@/lib/smartthings/webhook";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 30;

interface DeviceEvent {
  deviceId: string;
  componentId?: string;
  capability: string;
  attribute: string;
  value: unknown;
  stateChange?: boolean;
}

interface Lifecycle {
  lifecycle?: string;
  confirmationData?: { appId?: string; confirmationUrl?: string };
  pingData?: { challenge?: string };
  uninstallData?: { installedApp?: { installedAppId?: string } };
  eventData?: {
    installedApp?: { installedAppId?: string };
    events?: Array<{ eventType?: string; eventTime?: string; deviceEvent?: DeviceEvent }>;
  };
}

export async function POST(request: NextRequest) {
  const raw = await request.text();
  let body: Lifecycle;
  try {
    body = JSON.parse(raw) as Lifecycle;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  // Step 1: confirmation (only our own app, only a SmartThings link).
  if (body.lifecycle === "CONFIRMATION") {
    const url = body.confirmationData?.confirmationUrl ?? "";
    if (body.confirmationData?.appId && process.env.SMARTTHINGS_APP_ID && body.confirmationData.appId !== process.env.SMARTTHINGS_APP_ID) {
      return NextResponse.json({ error: "unknown_app" }, { status: 403 });
    }
    if (!isSmartThingsUrl(url)) return NextResponse.json({ error: "bad_confirmation" }, { status: 400 });
    await fetch(url, { cache: "no-store" }).catch(() => undefined);
    return NextResponse.json({ targetUrl: request.nextUrl.href });
  }

  // Step 2: ping.
  if (body.lifecycle === "PING") {
    return NextResponse.json({ pingData: { challenge: body.pingData?.challenge ?? "" } });
  }

  // Step 3: events, signed by SmartThings.
  if (body.lifecycle === "EVENT") {
    if (!(await verifySmartThingsRequest(request, raw, request.nextUrl.pathname))) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const admin = getSupabaseAdminClient();
    const installedAppId = body.eventData?.installedApp?.installedAppId;
    const { data: conn } = installedAppId
      ? await admin.from("home_connections").select("household_id").eq("installed_app_id", installedAppId).maybeSingle<{ household_id: string }>()
      : { data: null };
    if (conn) {
      for (const event of body.eventData?.events ?? []) {
        const d = event.deviceEvent;
        if (event.eventType !== "DEVICE_EVENT" || !d || (d.componentId && d.componentId !== "main")) continue;
        const { error } = await admin.rpc("home_record_event", {
          p_household_id: conn.household_id,
          p_external_id: d.deviceId,
          p_capability: d.capability,
          p_attribute: d.attribute,
          p_value: d.value ?? null,
          p_occurred_at: event.eventTime ?? new Date().toISOString(),
        });
        if (error) console.error("[smartthings] record event", error.message);
        // (The automations engine will run here, in a later step.)
      }
    }
    return NextResponse.json({ eventData: {} });
  }

  // Step 4: removed in the SmartThings app (signed too).
  if (body.lifecycle === "UNINSTALL") {
    if (!(await verifySmartThingsRequest(request, raw, request.nextUrl.pathname))) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const admin = getSupabaseAdminClient();
    const installedAppId = body.uninstallData?.installedApp?.installedAppId;
    const { data: conn } = installedAppId
      ? await admin.from("home_connections").select("household_id").eq("installed_app_id", installedAppId).maybeSingle<{ household_id: string }>()
      : { data: null };
    if (conn) await admin.rpc("home_remove_connection", { p_household_id: conn.household_id });
    return NextResponse.json({ uninstallData: {} });
  }

  // Anything else: acknowledge.
  return NextResponse.json({});
}
