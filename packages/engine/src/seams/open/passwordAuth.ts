import type { AuthProvider } from "../types.js";

const COOKIE = "solv_session";
// 30 days: the spec is silent. A single-owner install has no shared machines,
// and a shorter window means signing in mid-task. Rotating SOLV_SECRET_KEY
// invalidates every session.
const MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_FAILURES = 5;

/** Fixed by migration 0002 so the open build never has to discover its org. */
export const SINGLE_ORG_ID = "org_00000000000000000000";
const OWNER_USER_ID = "owner";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Length-independent: a plain === on the password or MAC leaks how much matched through timing. */
function equals(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let diff = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(input: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(input)) return null;
  const padded = input
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(input.length / 4) * 4, "=");
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

async function sign(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return encodeBase64Url(new Uint8Array(mac));
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (key === name) {
      return part.slice(idx + 1).trim();
    }
  }
  return null;
}

interface SessionPayload {
  orgId: string;
  userId: string;
  issuedAt: number;
}

function safeParse(payload: string): SessionPayload | null {
  const bytes = decodeBase64Url(payload);
  if (!bytes) return null;
  try {
    const parsed = JSON.parse(decoder.decode(bytes)) as Record<string, unknown>;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof parsed.orgId !== "string" ||
      typeof parsed.userId !== "string" ||
      typeof parsed.issuedAt !== "number" ||
      !Number.isFinite(parsed.issuedAt)
    ) {
      return null;
    }
    return { orgId: parsed.orgId, userId: parsed.userId, issuedAt: parsed.issuedAt };
  } catch {
    return null;
  }
}

function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "unknown";
}

export interface PasswordAuthEnv {
  SOLV_ADMIN_PASSWORD?: string | undefined;
  SOLV_SECRET_KEY?: string | undefined;
}

/** Single-owner password authentication backed by a signed HttpOnly cookie. */
export function passwordAuth(env: PasswordAuthEnv, db: D1Database): AuthProvider {
  return {
    async authenticate(request) {
      if (!env.SOLV_SECRET_KEY) return null;
      const raw = readCookie(request, COOKIE);
      if (!raw) return null;
      const parts = raw.split(".");
      if (parts.length !== 2) return null;
      const [payload, mac] = parts;
      if (!payload || !mac) return null;
      // Verify before parsing: never let unverified bytes decide anything, not
      // even which branch of a parser runs.
      const expected = await sign(payload, env.SOLV_SECRET_KEY);
      if (!equals(mac, expected)) return null;
      const body = safeParse(payload);
      if (body === null || Date.now() - body.issuedAt > MAX_AGE_SECONDS * 1000) return null;
      return { orgId: body.orgId, userId: body.userId, role: "owner" };
    },

    async login(request) {
      const body = (await request.json().catch(() => null)) as { password?: unknown } | null;
      const password = typeof body?.password === "string" ? body.password : "";
      const ip = clientIp(request);
      const now = Date.now();

      // Reserve an attempt slot atomically before verifying the password so
      // concurrent requests cannot all read a pre-threshold count and bypass
      // the limit. Lockout expiration is tracked independently of window_start
      // so the 15-minute wait always runs from the threshold-crossing failure.
      const attempt = await db
        .prepare(
          `INSERT INTO login_failures (org_id, ip, failures, window_start, locked_until)
           VALUES (?1, ?2, 1, ?3, 0)
           ON CONFLICT(org_id, ip) DO UPDATE SET
             failures = CASE
               WHEN login_failures.locked_until > ?3 THEN ?5 + 1
               WHEN ?3 - login_failures.window_start >= ?4 OR login_failures.failures >= ?5 THEN 1
               ELSE login_failures.failures + 1
             END,
             window_start = CASE
               WHEN login_failures.locked_until > ?3 THEN login_failures.window_start
               WHEN ?3 - login_failures.window_start >= ?4 OR login_failures.failures >= ?5 THEN ?3
               ELSE login_failures.window_start
             END,
             locked_until = CASE
               WHEN login_failures.locked_until > ?3 THEN login_failures.locked_until
               WHEN ?3 - login_failures.window_start >= ?4 OR login_failures.failures >= ?5 THEN 0
               WHEN login_failures.failures + 1 >= ?5 THEN ?3 + ?4
               ELSE 0
             END
           RETURNING failures, locked_until`,
        )
        .bind(SINGLE_ORG_ID, ip, now, LOGIN_WINDOW_MS, MAX_LOGIN_FAILURES)
        .first<{ failures: number; locked_until: number }>();

      if (attempt && attempt.failures > MAX_LOGIN_FAILURES) {
        const retryAfter = Math.max(1, Math.ceil((attempt.locked_until - now) / 1000));
        return Response.json(
          { error: "Too many failed sign-in attempts." },
          { status: 429, headers: { "retry-after": String(retryAfter) } },
        );
      }

      const valid = Boolean(
        env.SOLV_ADMIN_PASSWORD && env.SOLV_SECRET_KEY && equals(password, env.SOLV_ADMIN_PASSWORD),
      );

      if (!valid) {
        // One message for "unset" and "wrong" so the response does not say which.
        return Response.json({ error: "Sign-in failed." }, { status: 401 });
      }

      await db
        .prepare("DELETE FROM login_failures WHERE org_id = ?1 AND ip = ?2")
        .bind(SINGLE_ORG_ID, ip)
        .run();

      const payload = encodeBase64Url(
        encoder.encode(
          JSON.stringify({ orgId: SINGLE_ORG_ID, userId: OWNER_USER_ID, issuedAt: now }),
        ),
      );
      const mac = await sign(payload, env.SOLV_SECRET_KEY as string);
      return Response.json(
        { ok: true },
        {
          headers: {
            // HttpOnly keeps the session away from any script on the admin page;
            // SameSite=Lax suffices for a same-origin SPA with no cross-site POSTs.
            "set-cookie": `${COOKIE}=${payload}.${mac}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${MAX_AGE_SECONDS}`,
          },
        },
      );
    },

    async logout() {
      return Response.json(
        { ok: true },
        {
          headers: {
            "set-cookie": `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
          },
        },
      );
    },
  };
}
