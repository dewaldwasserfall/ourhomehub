/**
 * SmartThings devices, as HomeHub sees them. Pure functions (no network), so
 * they're unit-tested:
 *
 *   * classifyDevice()  which HomeHub kind a device is (TV, washer, light...)
 *   * stateFromStatus() the "main" component's values from a status response
 *   * deviceSummary()   one short line for lists ("On", "Running · 23 min left")
 */

/** HomeHub's own device groups (decide icon and controls). */
export type HomeDeviceKind = "tv" | "washer" | "dryer" | "dishwasher" | "light" | "switch" | "sensor" | "other";

/** { capability: { attribute: value } } for the device's main component. */
export type DeviceState = Record<string, Record<string, unknown>>;

/** The parts of a SmartThings device record we use. */
export interface StDevice {
  deviceId: string;
  label?: string;
  name?: string;
  roomId?: string;
  ocf?: { ocfDeviceType?: string };
  components?: Array<{ id: string; capabilities?: Array<{ id: string }>; categories?: Array<{ name: string }> }>;
}

// -----------------------------------------------------------------------------
// Step 1: which kind of device
// -----------------------------------------------------------------------------

/** The main component's capability ids. */
export function mainCapabilities(device: StDevice): string[] {
  const main = device.components?.find((c) => c.id === "main") ?? device.components?.[0];
  return (main?.capabilities ?? []).map((c) => c.id);
}

/**
 * The device's OCF type is the clearest signal (Samsung appliances and TVs
 * set it); otherwise the category, then the capabilities.
 */
export function classifyDevice(device: StDevice): HomeDeviceKind {
  const ocf = device.ocf?.ocfDeviceType ?? "";
  const category = (device.components?.find((c) => c.id === "main")?.categories?.[0]?.name ?? "").toLowerCase();
  const caps = new Set(mainCapabilities(device));

  if (ocf === "oic.d.tv" || category === "television" || caps.has("tvChannel") || caps.has("samsungvd.mediaInputSource")) return "tv";
  if (ocf === "oic.d.washer" || category === "washer" || caps.has("washerOperatingState")) return "washer";
  if (ocf === "oic.d.dryer" || category === "dryer" || caps.has("dryerOperatingState")) return "dryer";
  if (ocf === "oic.d.dishwasher" || category === "dishwasher" || caps.has("dishwasherOperatingState")) return "dishwasher";
  if (ocf === "oic.d.light" || category === "light" || caps.has("colorControl") || caps.has("colorTemperature")) return "light";
  if (caps.has("switch")) return "switch";
  if (["motionSensor", "contactSensor", "temperatureMeasurement", "presenceSensor", "waterSensor"].some((c) => caps.has(c))) return "sensor";
  return "other";
}

// -----------------------------------------------------------------------------
// Step 2: state from a status response
// -----------------------------------------------------------------------------

/**
 * GET /devices/{id}/status returns
 *   { components: { main: { switch: { switch: { value: "on", ... } } } } }
 * We keep { switch: { switch: "on" } } for the main component.
 */
export function stateFromStatus(status: { components?: Record<string, Record<string, Record<string, { value?: unknown }>>> }): DeviceState {
  const main = status.components?.main ?? {};
  const state: DeviceState = {};
  for (const [capability, attributes] of Object.entries(main)) {
    state[capability] = {};
    for (const [attribute, reading] of Object.entries(attributes ?? {})) {
      state[capability][attribute] = reading?.value ?? null;
    }
  }
  return state;
}

// -----------------------------------------------------------------------------
// Step 3: one line for lists
// -----------------------------------------------------------------------------

const MACHINE_STATES: Record<string, string> = { run: "Running", pause: "Paused", stop: "Idle" };

/** Minutes left from an ISO completion time. */
function minutesLeft(completionTime: unknown, now: Date): number | null {
  if (typeof completionTime !== "string") return null;
  const ms = Date.parse(completionTime) - now.getTime();
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms / 60_000) : null;
}

export function deviceSummary(kind: HomeDeviceKind, state: DeviceState, now = new Date()): string {
  const on = state.switch?.switch;
  if (kind === "washer" || kind === "dryer" || kind === "dishwasher") {
    const op = state[`${kind}OperatingState`] ?? {};
    const machine = MACHINE_STATES[String(op.machineState)] ?? "Unknown";
    const left = op.machineState === "run" ? minutesLeft(op.completionTime, now) : null;
    return left ? `${machine} · ${left} min left` : machine;
  }
  if (kind === "light") {
    const level = state.switchLevel?.level;
    if (on === "on" && typeof level === "number") return `On · ${level}%`;
  }
  if (kind === "sensor") {
    const temp = state.temperatureMeasurement?.temperature;
    if (typeof temp === "number") return `${temp}°`;
    if (state.contactSensor?.contact) return state.contactSensor.contact === "open" ? "Open" : "Closed";
    if (state.motionSensor?.motion) return state.motionSensor.motion === "active" ? "Motion" : "No motion";
  }
  if (on === "on") return "On";
  if (on === "off") return "Off";
  return "";
}
