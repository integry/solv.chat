import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantRow } from "../../src/db/assistants.js";
import type { VersionRow } from "../../src/db/versions.js";
import { createTestApp, TEST_ORG_ID } from "../helpers/app.js";

async function call(
  app: ReturnType<typeof createTestApp>,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const ctx = createExecutionContext();
  const headers: Record<string, string> = {};
  if (method !== "GET" && method !== "HEAD") {
    headers.Origin = "https://example.com";
  }
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  const response = await app.fetch(
    new Request(`https://example.com${path}`, {
      method,
      headers,
      body: body === undefined ? null : JSON.stringify(body),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

interface TableVersionRow {
  id: string;
  state: string;
  config: string;
  created_at: number;
  published_at: number | null;
}

async function tableVersions(assistantId: string): Promise<TableVersionRow[]> {
  const res = await env.DB.prepare(
    "SELECT id, state, config, created_at, published_at FROM assistant_versions WHERE assistant_id = ?1 ORDER BY rowid ASC",
  )
    .bind(assistantId)
    .all<TableVersionRow>();
  return res.results;
}

describe("admin versions API", () => {
  const app = createTestApp();
  let assistantId: string;

  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM assistant_versions"),
      env.DB.prepare("DELETE FROM assistants"),
    ]);

    const res = await call(app, "POST", "/api/admin/assistants", {
      name: "Versioned Bot",
      allowedOrigins: [],
    });
    const created = (await res.json()) as { assistant: AssistantRow };
    assistantId = created.assistant.id;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("publish moves draft to published and leaves exactly one draft and one published", async () => {
    await call(app, "PUT", `/api/admin/assistants/${assistantId}/draft`, {
      behaviour: { greeting: "Version 1 greeting" },
    });

    const pubRes = await call(app, "POST", `/api/admin/assistants/${assistantId}/publish`);
    expect(pubRes.status).toBe(200);
    const { version } = (await pubRes.json()) as { version: VersionRow };
    expect(version.state).toBe("published");
    expect(version.publishedAt).toEqual(expect.any(Number));

    const rows = await tableVersions(assistantId);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.state === "published")).toHaveLength(1);
    expect(rows.filter((r) => r.state === "draft")).toHaveLength(1);
    expect(rows.filter((r) => r.state === "archived")).toHaveLength(0);

    const published = rows.find((r) => r.state === "published");
    const draft = rows.find((r) => r.state === "draft");
    expect(published?.id).toBe(version.id);
    expect(JSON.parse(draft?.config ?? "{}").behaviour.greeting).toBe("Version 1 greeting");
  });

  it("a second publish archives the first and history is newest-first", async () => {
    const t0 = Date.now() + 1_000;
    vi.useFakeTimers();
    vi.setSystemTime(t0 + 1_000);
    await call(app, "PUT", `/api/admin/assistants/${assistantId}/draft`, {
      behaviour: { greeting: "V1" },
    });
    vi.setSystemTime(t0 + 2_000);
    const pub1 = (await (
      await call(app, "POST", `/api/admin/assistants/${assistantId}/publish`)
    ).json()) as { version: VersionRow };

    vi.setSystemTime(t0 + 3_000);
    await call(app, "PUT", `/api/admin/assistants/${assistantId}/draft`, {
      behaviour: { greeting: "V2" },
    });
    vi.setSystemTime(t0 + 4_000);
    const pub2 = (await (
      await call(app, "POST", `/api/admin/assistants/${assistantId}/publish`)
    ).json()) as { version: VersionRow };

    const rows = await tableVersions(assistantId);
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.state === "archived")).toHaveLength(1);
    expect(rows.filter((r) => r.state === "published")).toHaveLength(1);
    expect(rows.filter((r) => r.state === "draft")).toHaveLength(1);
    expect(rows.find((r) => r.id === pub1.version.id)?.state).toBe("archived");
    expect(rows.find((r) => r.id === pub2.version.id)?.state).toBe("published");

    const historyRes = await call(app, "GET", `/api/admin/assistants/${assistantId}/versions`);
    expect(historyRes.status).toBe(200);
    const { versions } = (await historyRes.json()) as { versions: VersionRow[] };
    expect(versions.map((v) => v.state)).toEqual(["draft", "published", "archived"]);
    expect(versions[0]?.createdAt).toBe(t0 + 4_000);
    expect(versions[1]?.publishedAt).toBe(t0 + 4_000);
    expect(versions[2]?.id).toBe(pub1.version.id);
  });

  it("rollback republishes an archived config without mutating the old row or the draft", async () => {
    const t0 = Date.now() + 1_000;
    vi.useFakeTimers();
    vi.setSystemTime(t0 + 1_000);
    await call(app, "PUT", `/api/admin/assistants/${assistantId}/draft`, {
      behaviour: { greeting: "Original V1" },
    });
    vi.setSystemTime(t0 + 2_000);
    const pub1 = (await (
      await call(app, "POST", `/api/admin/assistants/${assistantId}/publish`)
    ).json()) as { version: VersionRow };

    vi.setSystemTime(t0 + 3_000);
    await call(app, "PUT", `/api/admin/assistants/${assistantId}/draft`, {
      behaviour: { greeting: "V2" },
    });
    vi.setSystemTime(t0 + 4_000);
    await call(app, "POST", `/api/admin/assistants/${assistantId}/publish`);

    vi.setSystemTime(t0 + 5_000);
    await call(app, "PUT", `/api/admin/assistants/${assistantId}/draft`, {
      behaviour: { greeting: "Unpublished Draft V3" },
    });

    vi.setSystemTime(t0 + 6_000);
    const rbRes = await call(
      app,
      "POST",
      `/api/admin/assistants/${assistantId}/versions/${pub1.version.id}/rollback`,
    );
    expect(rbRes.status).toBe(200);
    const { version: rolledBack } = (await rbRes.json()) as { version: VersionRow };
    expect(rolledBack.id).not.toBe(pub1.version.id);
    expect(rolledBack.state).toBe("published");
    expect(rolledBack.config.behaviour.greeting).toBe("Original V1");

    const rows = await tableVersions(assistantId);
    expect(rows).toHaveLength(4);
    expect(rows.filter((r) => r.state === "published")).toHaveLength(1);
    expect(rows.filter((r) => r.state === "draft")).toHaveLength(1);
    expect(rows.filter((r) => r.state === "archived")).toHaveLength(2);

    // The original archived row was never mutated.
    const oldRow = rows.find((r) => r.id === pub1.version.id);
    expect(oldRow?.state).toBe("archived");
    expect(oldRow?.published_at).toBe(t0 + 2_000);

    // The draft was left untouched.
    const draftRow = rows.find((r) => r.state === "draft");
    expect(JSON.parse(draftRow?.config ?? "{}").behaviour.greeting).toBe("Unpublished Draft V3");
  });

  it("rejects rollback of the draft or the currently published version in plain words", async () => {
    const pubRes = await call(app, "POST", `/api/admin/assistants/${assistantId}/publish`);
    const { version: live } = (await pubRes.json()) as { version: VersionRow };
    const draftRes = await call(app, "GET", `/api/admin/assistants/${assistantId}/draft`);
    const { draft } = (await draftRes.json()) as { draft: VersionRow };

    const rbLive = await call(
      app,
      "POST",
      `/api/admin/assistants/${assistantId}/versions/${live.id}/rollback`,
    );
    expect(rbLive.status).toBe(400);
    const liveBody = (await rbLive.json()) as { error: string; fields: string[] };
    expect(liveBody.fields[0]).toMatch(/only an older version can be restored/i);

    const rbDraft = await call(
      app,
      "POST",
      `/api/admin/assistants/${assistantId}/versions/${draft.id}/rollback`,
    );
    expect(rbDraft.status).toBe(400);
    const draftBody = (await rbDraft.json()) as { error: string; fields: string[] };
    expect(draftBody.fields[0]).toMatch(/only an older version can be restored/i);
  });

  it("returns 400 with field name on invalid draft config and leaves draft unchanged", async () => {
    const before = (await (
      await call(app, "GET", `/api/admin/assistants/${assistantId}/draft`)
    ).json()) as { draft: VersionRow };

    const bad = await call(app, "PUT", `/api/admin/assistants/${assistantId}/draft`, {
      widget: { accentColor: "not-a-hex-color" },
      limits: { dailyCostCapMicros: -5 },
    });
    expect(bad.status).toBe(400);
    const body = (await bad.json()) as { error: string; fields: string[] };
    expect(body.fields.some((f) => f.includes("widget.accentColor"))).toBe(true);
    expect(body.fields.some((f) => f.includes("limits.dailyCostCapMicros"))).toBe(true);

    const after = (await (
      await call(app, "GET", `/api/admin/assistants/${assistantId}/draft`)
    ).json()) as { draft: VersionRow };
    expect(after.draft.config).toEqual(before.draft.config);
    expect(after.draft.orgId).toBe(TEST_ORG_ID);
  });
});
