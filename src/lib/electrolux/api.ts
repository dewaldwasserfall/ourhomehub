/**
 * Minimal Electrolux Group API client. SERVER ONLY.
 *
 * Credentials come from developer.electrolux.one (the owner's My AEG
 * account): an API key, an access token (a JWT, short-lived) and a refresh
 * token. Every call sends the API key and the access token; a refresh swaps
 * the refresh token for a new pair (the old refresh token stops working, so
 * the new one must be saved). HomeHub only reads.
 */

const API = "https://api.developer.electrolux.one/api/v1";
const USER_AGENT = "HomeHub (ourhomehub.nl)";

/** What we keep in Vault. */
export interface ElectroluxCredentials {
  apiKey: string;
  accessToken: string;
  refreshToken: string;
}

export class ElectroluxError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

// -----------------------------------------------------------------------------
// Step 1: tokens
// -----------------------------------------------------------------------------

/** Seconds since epoch when the access token runs out (from the JWT), or 0. */
export function tokenExpiry(accessToken: string): number {
  try {
    const payload = JSON.parse(Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString("utf8")) as { exp?: number };
    return typeof payload.exp === "number" ? payload.exp : 0;
  } catch {
    return 0;
  }
}

/** Still good for at least two minutes? */
export function tokenFresh(accessToken: string, nowSeconds = Date.now() / 1000): boolean {
  return tokenExpiry(accessToken) - nowSeconds > 120;
}

export async function refreshTokens(credentials: ElectroluxCredentials): Promise<ElectroluxCredentials> {
  const res = await fetch(`${API}/token/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
    body: JSON.stringify({ refreshToken: credentials.refreshToken }),
    cache: "no-store",
  });
  if (!res.ok) throw new ElectroluxError(`token refresh failed (${res.status})`, res.status);
  const data = (await res.json()) as { accessToken: string; refreshToken: string };
  return { apiKey: credentials.apiKey, accessToken: data.accessToken, refreshToken: data.refreshToken };
}

// -----------------------------------------------------------------------------
// Step 2: reading appliances
// -----------------------------------------------------------------------------

async function get<T>(credentials: ElectroluxCredentials, path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    headers: {
      Authorization: `Bearer ${credentials.accessToken}`,
      "x-api-key": credentials.apiKey,
      "User-Agent": USER_AGENT,
    },
    cache: "no-store",
  });
  if (!res.ok) throw new ElectroluxError(`GET ${path} failed (${res.status})`, res.status);
  return (await res.json()) as T;
}

export interface ElectroluxAppliance {
  applianceId: string;
  applianceName: string;
  /** "DW" for dishwashers. */
  applianceType: string;
}

export function listAppliances(credentials: ElectroluxCredentials) {
  return get<ElectroluxAppliance[]>(credentials, "/appliances");
}

export function getApplianceState(credentials: ElectroluxCredentials, applianceId: string) {
  return get<{ connectionState?: string; properties?: { reported?: Record<string, unknown> } }>(
    credentials,
    `/appliances/${encodeURIComponent(applianceId)}/state`,
  );
}

/** Best effort on disconnect: the refresh token stops working. */
export async function revokeTokens(credentials: ElectroluxCredentials): Promise<void> {
  await fetch(`${API}/token/revoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
    body: JSON.stringify({ refreshToken: credentials.refreshToken }),
    cache: "no-store",
  }).catch(() => undefined);
}
