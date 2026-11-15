import { env } from "cloudflare:test";
import { type App, createApp } from "../../src/app.js";
import type { AuthProvider, ScopeClaim, Seams } from "../../src/seams/types.js";

export const TEST_ORG_ID = "org_00000000000000000000";

/**
 * The test stand-in for `AuthProvider.resolveOrg`. The open build has one
 * org, so `passwordAuth` answers with it; these tests seed several orgs in
 * one database to prove isolation, so this plays the hosted service's part
 * and finds which org issued a credential. It is test code: the engine never
 * runs a statement without an org filter.
 */
export async function directoryResolveOrg(claim: ScopeClaim): Promise<string | null> {
  const lookup = async (sql: string, value: string) =>
    (await env.DB.prepare(sql).bind(value).first<{ org_id: string }>())?.org_id ?? null;
  switch (claim.kind) {
    case "public_key":
      return lookup("SELECT org_id FROM assistants WHERE public_key = ?1", claim.publicKey);
    case "message":
      return lookup("SELECT org_id FROM messages WHERE id = ?1", claim.messageId);
    case "ingest_key":
      return lookup("SELECT org_id FROM assistants WHERE id = ?1", claim.assistantId);
    case "preflight":
      return (
        (await lookup(
          "SELECT org_id FROM assistant_origins WHERE origin = ?1 LIMIT 1",
          claim.origin,
        )) ?? TEST_ORG_ID
      );
    case "queued_ingest":
      return claim.orgId;
  }
}

/** For `runIngestBatch` deps: accepts the claimed org, as `directoryResolveOrg` does. */
export const acceptQueuedOrg = async (orgId: string): Promise<string | null> => orgId;

export interface FakeSeamOverrides extends Partial<Omit<Seams, "auth">> {
  auth?: Partial<AuthProvider>;
}

export function fakeSeams(overrides: FakeSeamOverrides = {}): Seams {
  const { auth, ...rest } = overrides;
  return {
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
    ...rest,
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
      resolveOrg: directoryResolveOrg,
      ...auth,
    },
  };
}

export function createTestApp(overrides: FakeSeamOverrides = {}): App {
  return createApp(fakeSeams(overrides));
}
