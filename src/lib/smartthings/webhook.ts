/**
 * Checking that a webhook call really comes from SmartThings. SERVER ONLY.
 *
 * SmartThings signs every call with HTTP Signatures:
 *
 *   Authorization: Signature keyId="/pl/...",signature="base64...",
 *                  headers="(request-target) digest date",algorithm="rsa-sha256"
 *   Digest: SHA-256=<base64 sha256 of the body>
 *   Date:   <HTTP date>
 *
 * We rebuild the signed text from the named headers, fetch SmartThings'
 * public certificate for keyId from key.smartthings.com, and verify. The body
 * must match the digest, and the date must be recent (no replays).
 */
import { createHash, createVerify } from "node:crypto";

const KEY_HOST = "https://key.smartthings.com";
const MAX_SKEW_MS = 15 * 60_000;

export interface SignatureParams {
  keyId: string;
  signature: string;
  headers: string[];
  algorithm: string;
}

// -----------------------------------------------------------------------------
// Step 1: pure helpers (unit-tested)
// -----------------------------------------------------------------------------

/** `Signature keyId="..",signature=".."` -> its parts, or null. */
export function parseSignatureHeader(header: string | null): SignatureParams | null {
  if (!header) return null;
  const body = header.replace(/^Signature\s+/i, "");
  const parts: Record<string, string> = {};
  for (const match of body.matchAll(/(\w+)="([^"]*)"/g)) parts[match[1]] = match[2];
  if (!parts.keyId || !parts.signature) return null;
  return {
    keyId: parts.keyId,
    signature: parts.signature,
    headers: (parts.headers ?? "date").toLowerCase().split(/\s+/).filter(Boolean),
    algorithm: (parts.algorithm ?? "rsa-sha256").toLowerCase(),
  };
}

/** The text that was signed: one "name: value" line per listed header. */
export function signingString(names: string[], method: string, path: string, getHeader: (name: string) => string | null): string | null {
  const lines: string[] = [];
  for (const name of names) {
    if (name === "(request-target)") {
      lines.push(`(request-target): ${method.toLowerCase()} ${path}`);
      continue;
    }
    const value = getHeader(name);
    if (value === null) return null;
    lines.push(`${name}: ${value}`);
  }
  return lines.join("\n");
}

/** "SHA-256=<base64>" of the raw body. */
export function digestOf(body: string): string {
  return `SHA-256=${createHash("sha256").update(body, "utf8").digest("base64")}`;
}

/** keyIds look like a path on key.smartthings.com: nothing else is fetched. */
export function keyUrl(keyId: string): string | null {
  return /^\/[A-Za-z0-9/_.-]+$/.test(keyId) && !keyId.includes("..") ? `${KEY_HOST}${keyId}` : null;
}

// -----------------------------------------------------------------------------
// Step 2: verify a request
// -----------------------------------------------------------------------------

const certCache = new Map<string, string>();

async function certificate(keyId: string): Promise<string | null> {
  const cached = certCache.get(keyId);
  if (cached) return cached;
  const url = keyUrl(keyId);
  if (!url) return null;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return null;
  const pem = await res.text();
  certCache.set(keyId, pem);
  return pem;
}

/** True when the call is signed by SmartThings and the body is untouched. */
export async function verifySmartThingsRequest(request: Request, rawBody: string, path: string): Promise<boolean> {
  // 2a. The signature header, covering at least the date and the digest.
  const params = parseSignatureHeader(request.headers.get("authorization"));
  if (!params || params.algorithm !== "rsa-sha256" || !params.headers.includes("digest") || !params.headers.includes("date")) return false;

  // 2b. Body matches the digest; the date is recent.
  if (request.headers.get("digest") !== digestOf(rawBody)) return false;
  const date = Date.parse(request.headers.get("date") ?? "");
  if (!Number.isFinite(date) || Math.abs(Date.now() - date) > MAX_SKEW_MS) return false;

  // 2c. The signature checks out against SmartThings' certificate.
  const text = signingString(params.headers, request.method, path, (name) => request.headers.get(name));
  const pem = text === null ? null : await certificate(params.keyId);
  if (!text || !pem) return false;
  try {
    return createVerify("RSA-SHA256").update(text).verify(pem, params.signature, "base64");
  } catch {
    return false;
  }
}

/** Confirmation links must point at SmartThings itself (we fetch them). */
export function isSmartThingsUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && (u.hostname === "api.smartthings.com" || u.hostname.endsWith(".api.smartthings.com"));
  } catch {
    return false;
  }
}
