/**
 * Unit tests for SmartThings: device kinds, state, summaries, the OAuth link
 * and webhook signature checking.
 */
import { generateKeyPairSync, createSign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildAuthUrl } from "@/lib/smartthings/api";
import { classifyDevice, deviceSummary, stateFromStatus, type StDevice } from "@/lib/smartthings/devices";
import { digestOf, isSmartThingsUrl, keyUrl, parseSignatureHeader, signingString } from "@/lib/smartthings/webhook";

const device = (caps: string[], ocf?: string): StDevice => ({
  deviceId: "d",
  label: "x",
  ocf: ocf ? { ocfDeviceType: ocf } : undefined,
  components: [{ id: "main", capabilities: caps.map((id) => ({ id })) }],
});

describe("device kinds", () => {
  it("uses the OCF type first, then capabilities", () => {
    expect(classifyDevice(device(["switch"], "oic.d.tv"))).toBe("tv");
    expect(classifyDevice(device(["switch", "washerOperatingState"]))).toBe("washer");
    expect(classifyDevice(device(["switch", "dryerOperatingState"]))).toBe("dryer");
    expect(classifyDevice(device(["switch", "switchLevel", "colorControl"]))).toBe("light");
    expect(classifyDevice(device(["switch"]))).toBe("switch");
    expect(classifyDevice(device(["temperatureMeasurement"]))).toBe("sensor");
    expect(classifyDevice(device(["refresh"]))).toBe("other");
  });
});

describe("device state and summaries", () => {
  it("keeps the main component's values", () => {
    const state = stateFromStatus({
      components: {
        main: { switch: { switch: { value: "on" } }, switchLevel: { level: { value: 60 } } },
        other: { switch: { switch: { value: "off" } } },
      },
    });
    expect(state).toEqual({ switch: { switch: "on" }, switchLevel: { level: 60 } });
    expect(deviceSummary("light", state)).toBe("On · 60%");
  });

  it("shows time left on a running washer", () => {
    const now = new Date("2026-11-14T15:00:00Z");
    const state = { washerOperatingState: { machineState: "run", completionTime: "2026-11-14T15:23:00Z" } };
    expect(deviceSummary("washer", state, now)).toBe("Running · 23 min left");
    expect(deviceSummary("washer", { washerOperatingState: { machineState: "stop" } }, now)).toBe("Idle");
  });
});

describe("OAuth link", () => {
  it("asks for the three scopes and carries the state", () => {
    const url = new URL(buildAuthUrl("client", "https://ourhomehub.nl/api/smartthings/callback", "abc"));
    expect(url.origin + url.pathname).toBe("https://api.smartthings.com/oauth/authorize");
    expect(url.searchParams.get("scope")).toBe("r:devices:* x:devices:* r:locations:*");
    expect(url.searchParams.get("state")).toBe("abc");
    expect(url.searchParams.get("response_type")).toBe("code");
  });
});

describe("webhook signatures", () => {
  it("parses the header and rebuilds the signed text, which verifies with the key", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const body = JSON.stringify({ lifecycle: "EVENT" });
    const headers: Record<string, string> = { digest: digestOf(body), date: new Date().toUTCString() };
    const text = signingString(["(request-target)", "digest", "date"], "POST", "/api/smartthings/webhook", (n) => headers[n] ?? null)!;
    const signature = createSign("RSA-SHA256").update(text).sign(privateKey, "base64");

    const params = parseSignatureHeader(
      `Signature keyId="/pl/useast1/abc",signature="${signature}",headers="(request-target) digest date",algorithm="rsa-sha256"`,
    );
    expect(params).toMatchObject({ keyId: "/pl/useast1/abc", headers: ["(request-target)", "digest", "date"], algorithm: "rsa-sha256" });
    const { createVerify } = await import("node:crypto");
    expect(createVerify("RSA-SHA256").update(text).verify(publicKey, params!.signature, "base64")).toBe(true);
    // A changed body no longer matches the digest.
    expect(digestOf(body + " ")).not.toBe(headers.digest);
  });

  it("only fetches keys and confirmation links from SmartThings", () => {
    expect(keyUrl("/pl/useast1/abc")).toBe("https://key.smartthings.com/pl/useast1/abc");
    expect(keyUrl("https://evil.example/key")).toBeNull();
    expect(keyUrl("/../etc")).toBeNull();
    expect(isSmartThingsUrl("https://api.smartthings.com/apps/x/confirm-registration?token=1")).toBe(true);
    expect(isSmartThingsUrl("https://api.smartthings.com.evil.example/x")).toBe(false);
    expect(isSmartThingsUrl("http://api.smartthings.com/x")).toBe(false);
  });
});
