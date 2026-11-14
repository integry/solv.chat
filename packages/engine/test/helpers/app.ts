import { type App, createApp } from "../../src/app.js";
import type { Seams } from "../../src/seams/types.js";

export const TEST_ORG_ID = "org_00000000000000000000";

export function fakeSeams(overrides: Partial<Seams> = {}): Seams {
  return {
    auth: {
      async authenticate() {
        return { orgId: TEST_ORG_ID, userId: "owner", role: "owner" };
      },
      async login() {
        return Response.json({ ok: true });
      },
      async logout() {
        return Response.json({ ok: true });
      },
    },
    keys: {
      async modelKey(_orgId, provider) {
        return `test-${provider}-key`;
      },
      async embeddingKey() {
        return "test-embedding-key";
      },
    },
    usage: {
      async record() {},
    },
    limits: {
      async check() {
        return { ok: true };
      },
    },
    ...overrides,
  };
}

export function createTestApp(overrides: Partial<Seams> = {}): App {
  return createApp(fakeSeams(overrides));
}
