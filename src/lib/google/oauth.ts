/**
 * Google OAuth for the calendar connection (server only).
 *
 * Separate from app sign-in: this asks the family Google account for
 * long-lived ("offline") access to its calendar events, so the server can
 * keep syncing when nobody has the app open.
 */

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

/** Read and write events only, plus the account's email to show who's connected. */
export const CALENDAR_SCOPES = ["openid", "email", "https://www.googleapis.com/auth/calendar.events"];

/** Thrown when Google says the stored permission is gone (revoked or expired). */
export class GoogleAccessRevokedError extends Error {}

function clientCredentials() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set");
  return { clientId, clientSecret };
}

/** Step 1: the URL that sends the owner to Google's consent screen. */
export function buildConsentUrl(redirectUri: string, state: string, loginHint?: string): string {
  const { clientId } = clientCredentials();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: CALENDAR_SCOPES.join(" "),
    access_type: "offline", // we need a refresh token
    prompt: "consent select_account", // always return a refresh token, let them pick the account
    include_granted_scopes: "false",
    state,
  });
  if (loginHint) params.set("login_hint", loginHint);
  return `${AUTH_URL}?${params}`;
}

/** Step 2: swap the one-time code for tokens. */
export async function exchangeCode(code: string, redirectUri: string) {
  const { clientId, clientSecret } = clientCredentials();
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    scope?: string;
    error?: string;
  };
  if (!res.ok || !json.access_token) throw new Error(`token_exchange_failed: ${json.error ?? res.status}`);
  return json;
}

/** Step 3: a fresh short-lived access token from the stored refresh token. */
export async function refreshAccessToken(refreshToken: string): Promise<string> {
  const { clientId, clientSecret } = clientCredentials();
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    }),
  });
  const json = (await res.json()) as { access_token?: string; error?: string };
  if (json.error === "invalid_grant") throw new GoogleAccessRevokedError("Google access was revoked");
  if (!res.ok || !json.access_token) throw new Error(`token_refresh_failed: ${json.error ?? res.status}`);
  return json.access_token;
}

/** Step 4: tell Google to forget the permission (on disconnect). Best effort. */
export async function revokeToken(token: string): Promise<void> {
  await fetch(REVOKE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
  }).catch(() => undefined);
}

/**
 * The email inside Google's ID token. Safe to read without verifying the
 * signature: it came straight from Google's token endpoint over TLS.
 */
export function emailFromIdToken(idToken: string | undefined): string | null {
  if (!idToken) return null;
  try {
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString("utf8"));
    return typeof payload.email === "string" ? payload.email.toLowerCase() : null;
  } catch {
    return null;
  }
}
