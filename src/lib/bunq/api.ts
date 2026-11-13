/**
 * Minimal bunq API client. SERVER ONLY.
 *
 * bunq doesn't use plain bearer tokens. Connecting goes:
 *   1. OAuth: Dewald approves HomeHub in the bunq app -> an access token
 *   2. installation: register an RSA key pair made for this connection
 *   3. device-server: register the access token against that key (signed)
 *   4. session-server: open a session (signed) -> a session token that
 *      authenticates the actual API calls
 * Steps 2-3 happen once at connect time; their results, the private key and
 * the access token are kept together in Supabase Vault (BunqCredentials).
 * A session is opened for each sync.
 *
 * HomeHub only ever READS: the accounts list and the payments of the chosen
 * account. Nothing here can move money.
 *
 * Signing: bunq signs request bodies only (RSA PKCS#1 v1.5, SHA-256, base64),
 * on POSTs. GETs have no body to sign.
 */
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";

const API = "https://api.bunq.com/v1";
const OAUTH_AUTHORIZE = "https://oauth.bunq.com/auth";
const OAUTH_TOKEN = "https://api.oauth.bunq.com/v1/token";
const USER_AGENT = "HomeHub (ourhomehub.nl)";

/** Everything needed to open a session later. Stored as one Vault secret. */
export interface BunqCredentials {
  accessToken: string;
  privateKeyPem: string;
  installationToken: string;
}

export interface BunqSession {
  token: string;
  /** The id to use in /user/{id}/... URLs (the OAuth "UserApiKey" id). */
  userId: number;
  /** Names of the account holder, to recognise top-ups from own accounts. */
  holderNames: string[];
}

export interface BunqAccount {
  id: number;
  label: string;
  iban: string | null;
  balanceCents: number;
}

export interface BunqPayment {
  id: number;
  createdAt: string; // ISO instant
  amountCents: number;
  counterparty: string | null;
  description: string | null;
}

export class BunqError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = "BunqError";
  }
}

// -----------------------------------------------------------------------------
// Step 1: OAuth
// -----------------------------------------------------------------------------

function oauthClient() {
  const id = process.env.BUNQ_CLIENT_ID;
  const secret = process.env.BUNQ_CLIENT_SECRET;
  if (!id || !secret) throw new Error("BUNQ_CLIENT_ID and BUNQ_CLIENT_SECRET must be set");
  return { id, secret };
}

export function buildBunqAuthUrl(redirectUri: string, state: string): string {
  const params = new URLSearchParams({ response_type: "code", client_id: oauthClient().id, redirect_uri: redirectUri, state });
  return `${OAUTH_AUTHORIZE}?${params}`;
}

/** Exchange the code from the redirect for an access token. */
export async function exchangeBunqCode(code: string, redirectUri: string): Promise<string> {
  const { id, secret } = oauthClient();
  // bunq takes these as URL parameters on a POST (as in their docs).
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: id,
    client_secret: secret,
  });
  const res = await fetch(`${OAUTH_TOKEN}?${params}`, { method: "POST", headers: { "User-Agent": USER_AGENT } });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; error_description?: string };
  if (!res.ok || !json.access_token) throw new BunqError(json.error_description ?? "bunq didn't return an access token", res.status);
  return json.access_token;
}

// -----------------------------------------------------------------------------
// Step 2: low-level requests
// -----------------------------------------------------------------------------

function signBody(body: string, privateKeyPem: string): string {
  return sign("sha256", Buffer.from(body), privateKeyPem).toString("base64");
}

interface BunqResponse {
  Response?: Array<Record<string, unknown>>;
  Pagination?: { older_url?: string | null };
  Error?: Array<{ error_description?: string; error_description_translated?: string }>;
}

async function call(
  method: "GET" | "POST",
  path: string,
  opts: { auth?: string; body?: unknown; privateKeyPem?: string } = {},
): Promise<BunqResponse> {
  const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    "Cache-Control": "no-cache",
    "Content-Type": "application/json",
    "X-Bunq-Language": "en_US",
    "X-Bunq-Region": "nl_NL",
    "X-Bunq-Geolocation": "0 0 0 0 000",
    "X-Bunq-Client-Request-Id": randomUUID(),
  };
  if (opts.auth) headers["X-Bunq-Client-Authentication"] = opts.auth;
  if (body && opts.privateKeyPem) headers["X-Bunq-Client-Signature"] = signBody(body, opts.privateKeyPem);

  const res = await fetch(`${API}${path}`, { method, headers, body, cache: "no-store" });
  const json = (await res.json().catch(() => ({}))) as BunqResponse;
  if (!res.ok) {
    const message = json.Error?.[0]?.error_description ?? `bunq answered ${res.status}`;
    throw new BunqError(message, res.status);
  }
  return json;
}

/** bunq wraps everything as [{ "Type": {...} }, ...]; find the first of a type. */
function pick<T>(response: BunqResponse, type: string): T | undefined {
  for (const item of response.Response ?? []) if (type in item) return item[type] as T;
  return undefined;
}

// -----------------------------------------------------------------------------
// Step 3: the API context (once, when connecting) and sessions (every sync)
// -----------------------------------------------------------------------------

export async function createApiContext(accessToken: string): Promise<BunqCredentials> {
  // 3a. A key pair just for this connection.
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  // 3b. Installation (unsigned) -> installation token.
  const installation = await call("POST", "/installation", { body: { client_public_key: publicKey } });
  const installationToken = pick<{ token: string }>(installation, "Token")?.token;
  if (!installationToken) throw new BunqError("bunq didn't return an installation token", 500);

  // 3c. Register this server with the access token (signed). "*" because
  //     Vercel functions don't have fixed IP addresses.
  await call("POST", "/device-server", {
    auth: installationToken,
    privateKeyPem: privateKey,
    body: { description: "HomeHub", secret: accessToken, permitted_ips: ["*"] },
  });

  return { accessToken, privateKeyPem: privateKey, installationToken };
}

interface UserLike {
  id?: number;
  display_name?: string;
  legal_name?: string;
  public_nick_name?: string;
}

export async function openSession(creds: BunqCredentials): Promise<BunqSession> {
  const res = await call("POST", "/session-server", {
    auth: creds.installationToken,
    privateKeyPem: creds.privateKeyPem,
    body: { secret: creds.accessToken },
  });
  const token = pick<{ token: string }>(res, "Token")?.token;

  // OAuth sessions come back as a UserApiKey: its own id goes in the URLs,
  // and granted_by_user is the account holder.
  const apiKey = pick<{ id: number; granted_by_user?: Record<string, UserLike> }>(res, "UserApiKey");
  const person = pick<UserLike>(res, "UserPerson") ?? pick<UserLike>(res, "UserCompany");
  const holder = apiKey?.granted_by_user ? Object.values(apiKey.granted_by_user)[0] : person;
  const userId = apiKey?.id ?? person?.id;
  if (!token || !userId) throw new BunqError("bunq didn't open a session", 500);

  const holderNames = [holder?.display_name, holder?.legal_name, holder?.public_nick_name].filter((n): n is string => !!n);
  return { token, userId, holderNames };
}

// -----------------------------------------------------------------------------
// Step 4: reading accounts and payments
// -----------------------------------------------------------------------------

const toCents = (value: string | undefined) => Math.round(parseFloat(value ?? "0") * 100);

interface RawAccount {
  id: number;
  description?: string;
  status?: string;
  balance?: { value: string };
  alias?: Array<{ type: string; value: string }>;
}

/** Active accounts (bank, joint and savings), for choosing the groceries one. */
export async function listAccounts(session: BunqSession): Promise<BunqAccount[]> {
  const res = await call("GET", `/user/${session.userId}/monetary-account?count=100`, { auth: session.token });
  return (res.Response ?? [])
    .map((item) => Object.values(item)[0] as RawAccount)
    .filter((a) => a && a.status === "ACTIVE")
    .map((a) => ({
      id: a.id,
      label: a.description || "Account",
      iban: a.alias?.find((x) => x.type === "IBAN")?.value ?? null,
      balanceCents: toCents(a.balance?.value),
    }));
}

interface RawPayment {
  id: number;
  created: string; // "2026-11-13 10:00:00.000000" (UTC)
  amount?: { value: string };
  counterparty_alias?: { display_name?: string };
  description?: string;
}

/**
 * Payments on one account, newest first, back to `since` (an ISO instant).
 * Pages of 200 using bunq's older_id cursor.
 */
export async function listPayments(session: BunqSession, accountId: number, since: string): Promise<BunqPayment[]> {
  const payments: BunqPayment[] = [];
  let path: string | null = `/user/${session.userId}/monetary-account/${accountId}/payment?count=200`;
  for (let page = 0; path && page < 20; page++) {
    const res: BunqResponse = await call("GET", path, { auth: session.token });
    for (const item of res.Response ?? []) {
      const p = item.Payment as RawPayment | undefined;
      if (!p) continue;
      const createdAt = new Date(`${p.created.replace(" ", "T")}Z`).toISOString();
      if (createdAt < since) return payments;
      payments.push({
        id: p.id,
        createdAt,
        amountCents: toCents(p.amount?.value),
        counterparty: p.counterparty_alias?.display_name ?? null,
        description: p.description || null,
      });
    }
    // older_url looks like "/v1/user/1/monetary-account/2/payment?count=200&older_id=123"
    const older: string | null | undefined = res.Pagination?.older_url;
    path = older ? older.replace(/^\/v1/, "") : null;
  }
  return payments;
}
