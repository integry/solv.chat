import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { passwordAuth, SINGLE_ORG_ID } from "../../src/seams/open/passwordAuth.js";

const ENV = {
  SOLV_ADMIN_PASSWORD: "correct-horse-battery-staple",
  SOLV_SECRET_KEY: "test-secret-key-for-hmac-signing",
};

function loginRequest(password: string, ip = "203.0.113.10"): Request {
  return new Request("https://example.com/api/admin/login", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": ip,
    },
    body: JSON.stringify({ password }),
  });
}

function cookiePair(setCookie: string | null): string {
  expect(setCookie).toBeTruthy();
  return (setCookie as string).split(";")[0] as string;
}

describe("passwordAuth", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM login_failures").run();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sets HttpOnly, Secure, SameSite=Lax cookie on right password with no password echo", async () => {
    const auth = passwordAuth(ENV, env.DB);
    const res = await auth.login(loginRequest(ENV.SOLV_ADMIN_PASSWORD));

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(ENV.SOLV_ADMIN_PASSWORD);

    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toContain("solv_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");

    const principal = await auth.authenticate(
      new Request("https://example.com/api/admin/me", {
        headers: { cookie: cookiePair(setCookie) },
      }),
    );
    expect(principal).toEqual({
      orgId: SINGLE_ORG_ID,
      userId: "owner",
      role: "owner",
    });
  });

  it("returns 401 with no cookie on wrong password and identical message when unset", async () => {
    const auth = passwordAuth(ENV, env.DB);
    const wrongRes = await auth.login(loginRequest("wrong-password"));
    expect(wrongRes.status).toBe(401);
    expect(wrongRes.headers.get("set-cookie")).toBeNull();
    const wrongBody = await wrongRes.json();

    const unsetAuth = passwordAuth({ SOLV_SECRET_KEY: ENV.SOLV_SECRET_KEY }, env.DB);
    const unsetRes = await unsetAuth.login(loginRequest("anything", "203.0.113.11"));
    expect(unsetRes.status).toBe(401);
    expect(unsetRes.headers.get("set-cookie")).toBeNull();
    expect(await unsetRes.json()).toEqual(wrongBody);
  });

  it("rejects tampered payload, tampered signature, and expired cookie", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

    const auth = passwordAuth(ENV, env.DB);
    const res = await auth.login(loginRequest(ENV.SOLV_ADMIN_PASSWORD));
    const pair = cookiePair(res.headers.get("set-cookie"));
    const value = pair.slice("solv_session=".length);
    const [payload, mac] = value.split(".") as [string, string];

    const tamperedPayload = `${payload.slice(0, -1)}${payload.endsWith("A") ? "B" : "A"}.${mac}`;
    expect(
      await auth.authenticate(
        new Request("https://example.com/api/admin/me", {
          headers: { cookie: `solv_session=${tamperedPayload}` },
        }),
      ),
    ).toBeNull();

    const tamperedMac = `${payload}.${mac.slice(0, -1)}${mac.endsWith("A") ? "B" : "A"}`;
    expect(
      await auth.authenticate(
        new Request("https://example.com/api/admin/me", {
          headers: { cookie: `solv_session=${tamperedMac}` },
        }),
      ),
    ).toBeNull();

    vi.advanceTimersByTime(30 * 24 * 60 * 60 * 1000 + 1);
    expect(
      await auth.authenticate(
        new Request("https://example.com/api/admin/me", {
          headers: { cookie: pair },
        }),
      ),
    ).toBeNull();
  });

  it("clears the session cookie on logout", async () => {
    const auth = passwordAuth(ENV, env.DB);
    const res = await auth.logout(
      new Request("https://example.com/api/admin/logout", { method: "POST" }),
    );

    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toContain("solv_session=;");
    expect(setCookie).toContain("Max-Age=0");
  });

  it("drops other addresses' failure rows once their window and lock have both expired", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const auth = passwordAuth(ENV, env.DB);

    await auth.login(loginRequest("wrong", "198.51.100.20"));
    for (let i = 0; i < 5; i++) await auth.login(loginRequest("wrong", "198.51.100.21"));

    // Ten minutes on: neither window has run out, so both rows still count.
    vi.advanceTimersByTime(10 * 60 * 1000);
    await auth.login(loginRequest("wrong", "198.51.100.22"));
    const ips = async () =>
      (
        await env.DB.prepare("SELECT ip FROM login_failures ORDER BY ip").all<{ ip: string }>()
      ).results.map((r) => r.ip);
    expect(await ips()).toEqual(["198.51.100.20", "198.51.100.21", "198.51.100.22"]);

    // Sixteen minutes after the first failures: .20's window and .21's lock
    // have both ended, so a sign-in attempt from anywhere removes them.
    vi.advanceTimersByTime(6 * 60 * 1000);
    await auth.login(loginRequest("wrong", "198.51.100.23"));
    expect(await ips()).toEqual(["198.51.100.22", "198.51.100.23"]);
  });

  it("throttles after 5 failures per IP for 15 minutes without affecting other IPs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

    const auth = passwordAuth(ENV, env.DB);
    for (let i = 0; i < 5; i++) {
      const fail = await auth.login(loginRequest("wrong", "198.51.100.1"));
      expect(fail.status).toBe(401);
    }

    // 6th attempt is refused even with the right password.
    const blocked = await auth.login(loginRequest(ENV.SOLV_ADMIN_PASSWORD, "198.51.100.1"));
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);

    // Second IP is unaffected.
    const otherIp = await auth.login(loginRequest(ENV.SOLV_ADMIN_PASSWORD, "198.51.100.2"));
    expect(otherIp.status).toBe(200);

    // Accepted again after the 15-minute window.
    vi.advanceTimersByTime(15 * 60 * 1000 + 1);
    const afterWait = await auth.login(loginRequest(ENV.SOLV_ADMIN_PASSWORD, "198.51.100.1"));
    expect(afterWait.status).toBe(200);
  });

  it("keeps lockout for 15 minutes from the 5th failure when failures are spread across the window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));

    const auth = passwordAuth(ENV, env.DB);
    expect((await auth.login(loginRequest("wrong", "198.51.100.3"))).status).toBe(401);

    // Failures 2..5 happen 14m59s after the first failure.
    vi.setSystemTime(new Date("2026-01-01T12:14:59Z"));
    for (let i = 0; i < 4; i++) {
      expect((await auth.login(loginRequest("wrong", "198.51.100.3"))).status).toBe(401);
    }

    // 15m00s after the first failure (1s after the 5th failure): must still be locked out.
    vi.setSystemTime(new Date("2026-01-01T12:15:00Z"));
    const stillLocked = await auth.login(loginRequest(ENV.SOLV_ADMIN_PASSWORD, "198.51.100.3"));
    expect(stillLocked.status).toBe(429);
    expect(Number(stillLocked.headers.get("retry-after"))).toBeGreaterThanOrEqual(899);

    // 14m59s after the 5th failure: still locked out.
    vi.setSystemTime(new Date("2026-01-01T12:29:58Z"));
    expect((await auth.login(loginRequest(ENV.SOLV_ADMIN_PASSWORD, "198.51.100.3"))).status).toBe(
      429,
    );

    // 15m00s after the 5th failure: lockout expires.
    vi.setSystemTime(new Date("2026-01-01T12:29:59Z"));
    const unlocked = await auth.login(loginRequest(ENV.SOLV_ADMIN_PASSWORD, "198.51.100.3"));
    expect(unlocked.status).toBe(200);
  });

  it("prevents concurrent login attempts from bypassing the 5-failure threshold", async () => {
    const auth = passwordAuth(ENV, env.DB);
    const ip = "198.51.100.4";

    for (let i = 0; i < 4; i++) {
      expect((await auth.login(loginRequest("wrong", ip))).status).toBe(401);
    }

    // Fire 5 concurrent attempts at the 5th-attempt threshold: only 1 may be admitted.
    const responses = await Promise.all([
      auth.login(loginRequest("wrong", ip)),
      auth.login(loginRequest("wrong", ip)),
      auth.login(loginRequest("wrong", ip)),
      auth.login(loginRequest("wrong", ip)),
      auth.login(loginRequest(ENV.SOLV_ADMIN_PASSWORD, ip)),
    ]);

    const statuses = responses.map((r) => r.status);
    const admitted = statuses.filter((s) => s !== 429);
    const throttled = statuses.filter((s) => s === 429);
    expect(admitted).toHaveLength(1);
    expect(throttled).toHaveLength(4);
    for (const res of responses) {
      if (res.status === 429) {
        expect(res.headers.get("set-cookie")).toBeNull();
      }
    }
  });

  it("resolves every session-less request to the single org, and refuses a queued message naming another", async () => {
    const auth = passwordAuth(ENV, env.DB);
    expect(await auth.resolveOrg({ kind: "public_key", publicKey: "pk_any" })).toBe(SINGLE_ORG_ID);
    expect(await auth.resolveOrg({ kind: "message", messageId: "msg_any" })).toBe(SINGLE_ORG_ID);
    expect(await auth.resolveOrg({ kind: "ingest_key", assistantId: "ast_any" })).toBe(
      SINGLE_ORG_ID,
    );
    expect(await auth.resolveOrg({ kind: "preflight", origin: "https://a.example" })).toBe(
      SINGLE_ORG_ID,
    );
    expect(await auth.resolveOrg({ kind: "queued_ingest", orgId: SINGLE_ORG_ID })).toBe(
      SINGLE_ORG_ID,
    );
    expect(await auth.resolveOrg({ kind: "queued_ingest", orgId: "org_elsewhere" })).toBeNull();
  });

  it("uses a derived signing key rather than the raw SOLV_SECRET_KEY", async () => {
    const auth = passwordAuth(ENV, env.DB);
    const res = await auth.login(loginRequest(ENV.SOLV_ADMIN_PASSWORD));
    const pair = cookiePair(res.headers.get("set-cookie"));
    const value = pair.slice("solv_session=".length);
    const [payload, mac] = value.split(".") as [string, string];

    const rawKey = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(ENV.SOLV_SECRET_KEY),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const rawMacBytes = new Uint8Array(
      await crypto.subtle.sign("HMAC", rawKey, new TextEncoder().encode(payload)),
    );
    let binary = "";
    for (const byte of rawMacBytes) binary += String.fromCharCode(byte);
    const rawMac = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

    expect(mac).not.toBe(rawMac);
    expect(
      await auth.authenticate(
        new Request("https://example.com/api/admin/me", {
          headers: { cookie: `solv_session=${payload}.${rawMac}` },
        }),
      ),
    ).toBeNull();
  });
});
