// Signed visitor sessions for the public chat (see "Visitor check" in
// docs/architecture.md).
//
// Source for the WebCrypto subset available on Workers (HKDF deriveBits,
// HMAC sign/verify, SHA-256 digest):
// https://developers.cloudflare.com/workers/runtime-apis/web-crypto/ — checked 2026-11-20

import { deriveKeyBits } from "./secretBox.js";

const encoder = new TextEncoder();

/**
 * Labels for the two keys this file derives from SOLV_SECRET_KEY. Each is
 * independent of the admin session cookie key and of the stored-credential
 * key (`SESSION_KEY_INFO`, `SECRET_BOX_KEY_INFO` in `secretBox.ts`): HKDF
 * under a different label gives an unrelated key, so knowing one says
 * nothing about another.
 */
export const VISITOR_SESSION_KEY_INFO = "solv.chat visitor session v1";
export const VISITOR_COUNTER_KEY_INFO = "solv.chat visitor counter v1";

/** Version prefix, so the format can change without guessing. */
const FORMAT = "vs1";

/**
 * How long a visitor session lasts: one hour.
 *
 * A Turnstile token lasts 300 seconds and may be redeemed once, so the
 * session has to outlive it by enough to carry a whole visit: reading a few
 * pages and asking several questions over some minutes, with one check at
 * the start. An hour covers that, and it is the window the sessions-per-IP
 * cap counts in, so one network gets at most that many sessions an hour.
 * It is short enough that a session copied out of a browser stops working
 * within the hour, and every renewal is a fresh Turnstile check.
 */
export const VISITOR_SESSION_TTL_MS = 60 * 60 * 1000;

/** What a session is bound to. The org and assistant come from the engine, never the body. */
export interface VisitorSessionSubject {
  orgId: string;
  assistantId: string;
  visitorId: string;
}

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  try {
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

async function hmacKey(secret: string, info: string): Promise<CryptoKey> {
  const bits = await deriveKeyBits(secret, info);
  return crypto.subtle.importKey("raw", bits, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

/**
 * The signed text: the fields as a JSON array, so no choice of visitor id
 * can make two different subjects sign the same bytes.
 */
function signedText(
  subject: VisitorSessionSubject,
  expiresAt: number,
  nonce: string,
): Uint8Array<ArrayBuffer> {
  return encoder.encode(
    JSON.stringify([
      FORMAT,
      subject.orgId,
      subject.assistantId,
      subject.visitorId,
      expiresAt,
      nonce,
    ]),
  );
}

/**
 * Issues a session: `vs1.<expiry>.<nonce>.<mac>`. The org, assistant and
 * visitor are signed but not written into the string, so a session shows a
 * reader nothing but when it expires, and it verifies only for the subject
 * it was issued to.
 */
export async function issueVisitorSession(
  secret: string,
  subject: VisitorSessionSubject,
  now: number,
): Promise<{ session: string; expiresAt: number }> {
  const expiresAt = now + VISITOR_SESSION_TTL_MS;
  const nonce = base64url(crypto.getRandomValues(new Uint8Array(12)));
  const key = await hmacKey(secret, VISITOR_SESSION_KEY_INFO);
  const mac = await crypto.subtle.sign("HMAC", key, signedText(subject, expiresAt, nonce));
  return { session: `${FORMAT}.${expiresAt}.${nonce}.${base64url(mac)}`, expiresAt };
}

/** Why a session was not accepted. Never shown to a visitor beyond "check again". */
export type VisitorSessionFailure = "missing" | "malformed" | "expired" | "invalid";

/**
 * Checks a session for this subject. A session for another assistant, org
 * or visitor fails the MAC check (`invalid`), as does any edit to it.
 */
export async function verifyVisitorSession(
  secret: string,
  subject: VisitorSessionSubject,
  session: string | undefined,
  now: number,
): Promise<{ ok: true } | { ok: false; reason: VisitorSessionFailure }> {
  if (session === undefined || session === "") return { ok: false, reason: "missing" };
  const parts = session.split(".");
  if (parts.length !== 4 || parts[0] !== FORMAT) return { ok: false, reason: "malformed" };
  const [, expiryText = "", nonce = "", macText = ""] = parts;
  if (!/^\d{1,16}$/.test(expiryText) || !/^[A-Za-z0-9_-]{16}$/.test(nonce)) {
    return { ok: false, reason: "malformed" };
  }
  const mac = fromBase64url(macText);
  if (mac === null || mac.byteLength !== 32) return { ok: false, reason: "malformed" };
  const expiresAt = Number(expiryText);
  const key = await hmacKey(secret, VISITOR_SESSION_KEY_INFO);
  // `verify` compares in constant time.
  const valid = await crypto.subtle.verify("HMAC", key, mac, signedText(subject, expiresAt, nonce));
  if (!valid) return { ok: false, reason: "invalid" };
  // Checked after the MAC so an edited expiry reads as tampering, not expiry.
  if (expiresAt <= now) return { ok: false, reason: "expired" };
  return { ok: true };
}

/**
 * A counter subject: an HMAC of a visitor id or IP, so the counters table
 * never holds the value itself. 16 bytes is ample to keep subjects apart.
 */
export async function counterSubject(secret: string, kind: string, value: string): Promise<string> {
  const key = await hmacKey(secret, VISITOR_COUNTER_KEY_INFO);
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(`${kind}\n${value}`));
  return base64url(new Uint8Array(mac).slice(0, 16));
}

/** SHA-256 of a Turnstile token, for the spent-token table. */
export async function tokenHash(token: string): Promise<string> {
  return base64url(await crypto.subtle.digest("SHA-256", encoder.encode(token)));
}
