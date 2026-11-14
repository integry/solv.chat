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
});
