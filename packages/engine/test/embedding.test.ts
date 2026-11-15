import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  type AuthProvider,
  basicLimits,
  type CapMicrosResolver,
  createApp,
  DEFAULT_DAILY_CAP_MICROS,
  type PasswordAuthEnv,
  passwordAuth,
  type SecretKeyEnv,
  SINGLE_ORG_ID,
  secretKeys,
  usageDaily,
} from "../src/index.js";

describe("embedding contract", () => {
  it("builds default seams from the package entry point and serves /health", async () => {
    const authEnv: PasswordAuthEnv = env;
    const keyEnv: SecretKeyEnv = env;
    const capResolver: CapMicrosResolver = async () => DEFAULT_DAILY_CAP_MICROS;

    const app = createApp({
      auth: passwordAuth(authEnv, env.DB),
      keys: secretKeys(keyEnv, env.DB),
      usage: usageDaily(env.DB),
      limits: basicLimits(env.DB, capResolver),
    });

    const ctx = createExecutionContext();
    const response = await app.fetch(new Request("https://example.com/health"), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("uses a custom AuthProvider swapped in for the default", async () => {
    const authenticate = vi.fn(async () => ({
      orgId: SINGLE_ORG_ID,
      userId: "embedded-user",
      role: "owner" as const,
    }));
    const customAuth: AuthProvider = {
      authenticate,
      resolveOrg: async () => SINGLE_ORG_ID,
      login: async () => Response.json({ ok: true }),
      logout: async () => Response.json({ ok: true }),
    };

    const app = createApp({
      auth: customAuth,
      keys: secretKeys(env, env.DB),
      usage: usageDaily(env.DB),
      limits: basicLimits(env.DB),
    });

    const ctx = createExecutionContext();
    const response = await app.fetch(
      new Request("https://example.com/api/admin/assistants"),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(authenticate).toHaveBeenCalledOnce();
    expect(response.status).toBe(200);
  });
});
