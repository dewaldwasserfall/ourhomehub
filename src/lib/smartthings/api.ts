/**
 * Minimal SmartThings API client. SERVER ONLY.
 *
 * HomeHub connects as an "OAuth-In" app registered under Dewald's Samsung
 * account (client id and secret in Vercel env: SMARTTHINGS_CLIENT_ID,
 * SMARTTHINGS_CLIENT_SECRET). The owner approves it for one location (home);
 * SmartThings returns an access token (24 hours), a refresh token and the
 * installed app id. Tokens live in Supabase Vault (see tokens.ts).
 *
 * Scopes: r:devices:* (list and read devices), x:devices:* (send commands),
 * r:locations:* (the location and its rooms).
 */

const API = "https://api.smartthings.com/v1";
const OAUTH_AUTHORIZE = "https://api.smartthings.com/oauth/authorize";
const OAUTH_TOKEN = "https://api.smartthings.com/oauth/token";
export const SMARTTHINGS_SCOPES = ["r:devices:*", "x:devices:*", "r:locations:*"];

/** What we keep in Vault. */
export interface StCredentials {
  accessToken: string;
  refreshToken: string;
  /** ISO instant the access token runs out. */
  expiresAt: string;
  installedAppId: string;
}

export class SmartThingsError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

// -----------------------------------------------------------------------------
// Step 1: configuration
// -----------------------------------------------------------------------------

/** Client id and secret, or null when SmartThings isn't set up in Vercel yet. */
export function smartThingsConfig(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.SMARTTHINGS_CLIENT_ID;
  const clientSecret = process.env.SMARTTHINGS_CLIENT_SECRET;
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

// -----------------------------------------------------------------------------
// Step 2: OAuth
// -----------------------------------------------------------------------------

export function buildAuthUrl(clientId: string, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: SMARTTHINGS_SCOPES.join(" "),
    state,
  });
  return `${OAUTH_AUTHORIZE}?${params.toString()}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  installed_app_id?: string;
}

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const config = smartThingsConfig();
  if (!config) throw new SmartThingsError("SmartThings isn't set up", 503);
  const res = await fetch(OAUTH_TOKEN, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
    },
    body: new URLSearchParams({ client_id: config.clientId, ...body }).toString(),
    cache: "no-store",
  });
  if (!res.ok) throw new SmartThingsError(`token request failed (${res.status})`, res.status);
  return (await res.json()) as TokenResponse;
}

function toCredentials(token: TokenResponse, installedAppId?: string): StCredentials {
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString(),
    installedAppId: token.installed_app_id ?? installedAppId ?? "",
  };
}

/** The code from the callback -> tokens. */
export async function exchangeCode(code: string, redirectUri: string): Promise<StCredentials> {
  return toCredentials(await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri }));
}

/** A fresh access token (and a new refresh token: the old one stops working). */
export async function refreshCredentials(credentials: StCredentials): Promise<StCredentials> {
  return toCredentials(await tokenRequest({ grant_type: "refresh_token", refresh_token: credentials.refreshToken }), credentials.installedAppId);
}

// -----------------------------------------------------------------------------
// Step 3: API calls
// -----------------------------------------------------------------------------

export async function stFetch<T>(accessToken: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
    cache: "no-store",
  });
  if (!res.ok) throw new SmartThingsError(`${init.method ?? "GET"} ${path} failed (${res.status})`, res.status);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

/** The installed app tells us which location the owner picked. */
export async function getInstalledApp(accessToken: string, installedAppId: string) {
  return stFetch<{ installedAppId: string; locationId: string }>(accessToken, `/installedapps/${installedAppId}`);
}

export async function getLocation(accessToken: string, locationId: string) {
  return stFetch<{ locationId: string; name: string }>(accessToken, `/locations/${locationId}`);
}

export async function listRooms(accessToken: string, locationId: string) {
  const data = await stFetch<{ items: Array<{ roomId: string; name: string }> }>(accessToken, `/locations/${locationId}/rooms`);
  return data.items ?? [];
}

export async function listDevices(accessToken: string, locationId: string) {
  const data = await stFetch<{ items: import("./devices").StDevice[] }>(accessToken, `/devices?locationId=${encodeURIComponent(locationId)}`);
  return data.items ?? [];
}

export async function getDeviceStatus(accessToken: string, deviceId: string) {
  return stFetch<{ components?: Record<string, Record<string, Record<string, { value?: unknown }>>> }>(accessToken, `/devices/${deviceId}/status`);
}

/**
 * Ask SmartThings to send this device's changes to our webhook. Only works
 * once the app has a confirmed Target URL; callers treat a failure as
 * "not yet" rather than fatal.
 */
export async function subscribeToDevice(accessToken: string, installedAppId: string, deviceId: string, name: string) {
  return stFetch(accessToken, `/installedapps/${installedAppId}/subscriptions`, {
    method: "POST",
    body: JSON.stringify({
      sourceType: "DEVICE",
      device: { deviceId, componentId: "main", capability: "*", attribute: "*", stateChangeOnly: true, subscriptionName: name },
    }),
  });
}

export async function deleteAllSubscriptions(accessToken: string, installedAppId: string) {
  return stFetch(accessToken, `/installedapps/${installedAppId}/subscriptions`, { method: "DELETE" });
}

/** Remove the installed app: SmartThings forgets HomeHub for this home. */
export async function deleteInstalledApp(accessToken: string, installedAppId: string) {
  return stFetch(accessToken, `/installedapps/${installedAppId}`, { method: "DELETE" });
}
