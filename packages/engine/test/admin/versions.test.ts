import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { newId } from "@solvchat/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Conflict } from "../../src/admin/errors.js";
import { adminRoutes } from "../../src/admin/router.js";
import { publishDraft, updateDraft } from "../../src/admin/versions.js";
import { createApp } from "../../src/app.js";
import type { AssistantRow } from "../../src/db/assistants.js";
import { forPrincipal } from "../../src/db/tenant.js";
import type { VersionRow } from "../../src/db/versions.js";
import { ANTHROPIC_MODELS } from "../../src/models.js";
import type { LlmChunk, LlmProvider } from "../../src/providers/types.js";
import type { fakeEmbedder } from "../fakes/fakeEmbedder.js";
import { memoryRetriever } from "../fakes/memoryRetriever.js";
import { createTestApp, fakeSeams, TEST_ORG_ID } from "../helpers/app.js";

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

  it("publishes only the draft that was confirmed: a draft saved since is refused with draft_changed", async () => {
    await call(app, "PUT", `/api/admin/assistants/${assistantId}/draft`, {
      behaviour: { greeting: "Reviewed greeting" },
    });
    // Tab A opens "What will change" and reads the draft with its revision.
    const shown = (await (
      await call(app, "GET", `/api/admin/assistants/${assistantId}/draft`)
    ).json()) as { draft: VersionRow; revision: string };
    expect(shown.revision).toMatch(/^[0-9a-f]{64}$/);

    // Tab B saves while A's dialog is open.
    await call(app, "PUT", `/api/admin/assistants/${assistantId}/draft`, {
      behaviour: { greeting: "Never reviewed" },
    });

    const refused = await call(app, "POST", `/api/admin/assistants/${assistantId}/publish`, {
      expected: { draftId: shown.draft.id, revision: shown.revision },
    });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "draft_changed" });
    expect((await tableVersions(assistantId)).filter((r) => r.state === "published")).toEqual([]);

    // A reads the comparison again and confirms what is there now.
    const again = (await (
      await call(app, "GET", `/api/admin/assistants/${assistantId}/draft`)
    ).json()) as { draft: VersionRow; revision: string };
    expect(again.revision).not.toBe(shown.revision);
    const published = await call(app, "POST", `/api/admin/assistants/${assistantId}/publish`, {
      expected: { draftId: again.draft.id, revision: again.revision },
    });
    expect(published.status).toBe(200);
    const live = (await tableVersions(assistantId)).find((r) => r.state === "published");
    expect(JSON.parse(live?.config ?? "{}").behaviour.greeting).toBe("Never reviewed");
  });

  it("refuses a confirmed draft that was published meanwhile, and a malformed one", async () => {
    const shown = (await (
      await call(app, "GET", `/api/admin/assistants/${assistantId}/draft`)
    ).json()) as { draft: VersionRow; revision: string };
    // Another tab publishes: the confirmed draft row is no longer the draft.
    expect((await call(app, "POST", `/api/admin/assistants/${assistantId}/publish`)).status).toBe(
      200,
    );
    const stale = await call(app, "POST", `/api/admin/assistants/${assistantId}/publish`, {
      expected: { draftId: shown.draft.id, revision: shown.revision },
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "draft_changed" });

    const malformed = await call(app, "POST", `/api/admin/assistants/${assistantId}/publish`, {
      expected: { draftId: shown.draft.id },
    });
    expect(malformed.status).toBe(400);
  });

  it("binds promotion to the confirmed draft's config, so a save after the check still cannot go live", async () => {
    const tenant = forPrincipal(env.DB, { orgId: TEST_ORG_ID, userId: "owner", role: "owner" });
    const confirmed = await tenant.versions.draft(assistantId);
    if (confirmed === null) throw new Error("expected a draft");
    await call(app, "PUT", `/api/admin/assistants/${assistantId}/draft`, {
      behaviour: { greeting: "Saved after the check" },
    });
    const error = await publishDraft(tenant, assistantId, confirmed).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Conflict);
    expect((error as Conflict).code).toBe("draft_changed");
    expect((await tableVersions(assistantId)).filter((r) => r.state === "published")).toEqual([]);
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

  it("always lists the draft and the live version, even past the history limit", async () => {
    const pub = (await (
      await call(app, "POST", `/api/admin/assistants/${assistantId}/publish`)
    ).json()) as { version: VersionRow };
    const rows = await tableVersions(assistantId);
    const draftRow = rows.find((r) => r.state === "draft");
    expect(draftRow).toBeDefined();
    // 100 newer rows, as repeated restores leave behind: the bounded history
    // ordered by created_at no longer reaches the draft or the live version.
    const later = Date.now() + 60_000;
    await env.DB.batch(
      Array.from({ length: 100 }, (_, i) =>
        env.DB.prepare(
          "INSERT INTO assistant_versions (id, org_id, assistant_id, state, config, created_at, published_at) VALUES (?1, ?2, ?3, 'archived', ?4, ?5, ?5)",
        ).bind(newId("ver"), TEST_ORG_ID, assistantId, draftRow?.config, later + i),
      ),
    );

    const res = await call(app, "GET", `/api/admin/assistants/${assistantId}/versions`);
    const { versions } = (await res.json()) as { versions: VersionRow[] };
    expect(versions).toHaveLength(102);
    expect(versions.slice(0, 100).every((v) => v.state === "archived")).toBe(true);
    expect(versions.find((v) => v.state === "draft")?.id).toBe(draftRow?.id);
    expect(versions.find((v) => v.state === "published")?.id).toBe(pub.version.id);
    // Still newest first, by when each was published (the draft: created).
    const times = versions.map((v) => v.publishedAt ?? v.createdAt);
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it("keeps published versions unbroken when an old draft is published and then replaced past the history limit", async () => {
    const pub = (await (
      await call(app, "POST", `/api/admin/assistants/${assistantId}/publish`)
    ).json()) as { version: VersionRow };
    const oldDraft = (await tableVersions(assistantId)).find((r) => r.state === "draft");
    expect(oldDraft).toBeDefined();
    await call(app, "PUT", `/api/admin/assistants/${assistantId}/draft`, {
      behaviour: { greeting: "Old draft greeting" },
    });

    // 100 restores while the draft is kept: each archived the live version
    // and published a newer row, all created after the draft.
    const t0 = Date.now() + 60_000;
    const restoreIds = Array.from({ length: 100 }, () => newId("ver"));
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE assistant_versions SET state = 'archived' WHERE assistant_id = ?1 AND state = 'published'",
      ).bind(assistantId),
      ...restoreIds.map((id, i) =>
        env.DB.prepare(
          "INSERT INTO assistant_versions (id, org_id, assistant_id, state, config, created_at, published_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
        ).bind(
          id,
          TEST_ORG_ID,
          assistantId,
          i === restoreIds.length - 1 ? "published" : "archived",
          JSON.stringify({
            ...JSON.parse(oldDraft?.config ?? "{}"),
            behaviour: {
              ...JSON.parse(oldDraft?.config ?? "{}").behaviour,
              greeting: `Restore ${i}`,
            },
          }),
          t0 + i * 1_000,
        ),
      ),
    ]);

    // Publish the old draft: it keeps its old created_at.
    vi.useFakeTimers();
    vi.setSystemTime(t0 + 200_000);
    const published = await call(app, "POST", `/api/admin/assistants/${assistantId}/publish`);
    expect(published.status).toBe(200);
    expect(((await published.json()) as { version: VersionRow }).version.id).toBe(oldDraft?.id);

    // Restore a visible archived version: the old draft is now archived.
    vi.setSystemTime(t0 + 300_000);
    const restored = await call(
      app,
      "POST",
      `/api/admin/assistants/${assistantId}/versions/${restoreIds[98]}/rollback`,
    );
    expect(restored.status).toBe(200);
    const restoredId = ((await restored.json()) as { version: VersionRow }).version.id;
    expect((await tableVersions(assistantId)).find((r) => r.id === oldDraft?.id)?.state).toBe(
      "archived",
    );

    const res = await call(app, "GET", `/api/admin/assistants/${assistantId}/versions`);
    const { versions } = (await res.json()) as { versions: VersionRow[] };
    const listed = versions.filter((v) => v.publishedAt !== null).map((v) => v.id);
    // The listed publications are exactly the newest ones, with no gap.
    const all = (await tableVersions(assistantId))
      .filter((r) => r.published_at !== null)
      .sort((a, b) => (b.published_at ?? 0) - (a.published_at ?? 0))
      .map((r) => r.id);
    expect(listed).toEqual(all.slice(0, listed.length));
    // The restore is listed right above the old draft it replaced.
    expect(listed.slice(0, 3)).toEqual([restoredId, oldDraft?.id, restoreIds[99]]);
    expect(listed).not.toContain(pub.version.id);
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

  it("successive partial section saves preserve previously customized sections and fields", async () => {
    const first = await call(app, "PUT", `/api/admin/assistants/${assistantId}/draft`, {
      widget: { title: "Support Bot" },
      limits: { dailyCostCapMicros: 500 },
    });
    expect(first.status).toBe(200);

    const second = await call(app, "PUT", `/api/admin/assistants/${assistantId}/draft`, {
      behaviour: { greeting: "Welcome" },
    });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { draft: VersionRow };
    expect(secondBody.draft.config.behaviour.greeting).toBe("Welcome");
    expect(secondBody.draft.config.widget.title).toBe("Support Bot");
    expect(secondBody.draft.config.limits.dailyCostCapMicros).toBe(500);

    const third = await call(app, "PUT", `/api/admin/assistants/${assistantId}/draft`, {
      widget: { accentColor: "#112233" },
    });
    expect(third.status).toBe(200);

    const fetched = (await (
      await call(app, "GET", `/api/admin/assistants/${assistantId}/draft`)
    ).json()) as { draft: VersionRow };
    expect(fetched.draft.config.behaviour.greeting).toBe("Welcome");
    expect(fetched.draft.config.widget).toEqual({
      title: "Support Bot",
      accentColor: "#112233",
      position: "right",
    });
    expect(fetched.draft.config.limits.dailyCostCapMicros).toBe(500);
  });

  it("publish returns and copies the latest committed draft when an update completes between read and batch", async () => {
    await call(app, "PUT", `/api/admin/assistants/${assistantId}/draft`, {
      behaviour: { greeting: "Initial A" },
      limits: { dailyCostCapMicros: 500 },
    });

    const tenant = forPrincipal(env.DB, {
      orgId: TEST_ORG_ID,
      userId: "owner",
      role: "owner",
    });
    const racingTenant = {
      ...tenant,
      versions: {
        ...tenant.versions,
        async draft(id: string) {
          const read = await tenant.versions.draft(id);
          await updateDraft(tenant, id, {
            behaviour: { greeting: "Updated B" },
            limits: { dailyCostCapMicros: 1234 },
          });
          return read;
        },
      },
    };

    const published = await publishDraft(racingTenant, assistantId);
    expect(published.state).toBe("published");
    expect(published.config.behaviour.greeting).toBe("Updated B");
    expect(published.config.limits.dailyCostCapMicros).toBe(1234);

    const rows = await tableVersions(assistantId);
    expect(rows).toHaveLength(2);
    const publishedRow = rows.find((r) => r.state === "published");
    const freshDraftRow = rows.find((r) => r.state === "draft");
    expect(publishedRow?.id).toBe(published.id);
    expect(JSON.parse(publishedRow?.config ?? "{}")).toEqual(published.config);
    expect(JSON.parse(freshDraftRow?.config ?? "{}")).toEqual(published.config);
  });

  it("saves a draft whose stored config does not round-trip byte for byte", async () => {
    const [row] = await tableVersions(assistantId);
    // A hand edit: reformatted JSON plus a key the schema drops on parse.
    const handEdited = JSON.stringify(
      { ...JSON.parse(row?.config ?? "{}"), legacy: true },
      null,
      2,
    );
    await env.DB.prepare("UPDATE assistant_versions SET config = ?1 WHERE id = ?2")
      .bind(handEdited, row?.id)
      .run();

    const res = await call(app, "PUT", `/api/admin/assistants/${assistantId}/draft`, {
      behaviour: { greeting: "Saved anyway" },
    });
    expect(res.status).toBe(200);
    const [saved] = await tableVersions(assistantId);
    expect(JSON.parse(saved?.config ?? "{}").behaviour.greeting).toBe("Saved anyway");
  });

  it("still refuses a write when the stored config changed after it was read", async () => {
    const tenant = forPrincipal(env.DB, { orgId: TEST_ORG_ID, userId: "owner", role: "owner" });
    const read = await tenant.versions.draft(assistantId);
    if (read === null) throw new Error("no draft");
    await updateDraft(tenant, assistantId, { behaviour: { greeting: "Someone else" } });

    const written = await tenant.versions.updateDraft(assistantId, read.config, read);
    expect(written).toBe(false);
    const [row] = await tableVersions(assistantId);
    expect(JSON.parse(row?.config ?? "{}").behaviour.greeting).toBe("Someone else");
  });

  it("overlapping partial saves to different sections preserve both changes", async () => {
    const tenant = forPrincipal(env.DB, {
      orgId: TEST_ORG_ID,
      userId: "owner",
      role: "owner",
    });

    let triggered = false;
    const racingTenant = {
      ...tenant,
      versions: {
        ...tenant.versions,
        async draft(id: string) {
          const read = await tenant.versions.draft(id);
          if (!triggered) {
            triggered = true;
            await updateDraft(tenant, id, {
              limits: { dailyCostCapMicros: 500 },
            });
          }
          return read;
        },
      },
    };

    const result = await updateDraft(racingTenant, assistantId, {
      behaviour: { greeting: "Concurrent greeting" },
    });
    expect(result.config.limits.dailyCostCapMicros).toBe(500);
    expect(result.config.behaviour.greeting).toBe("Concurrent greeting");

    const rows = await tableVersions(assistantId);
    expect(rows).toHaveLength(1);
    const savedConfig = JSON.parse(rows[0]?.config ?? "{}");
    expect(savedConfig.limits.dailyCostCapMicros).toBe(500);
    expect(savedConfig.behaviour.greeting).toBe("Concurrent greeting");
  });

  it("rejects draft save with 409 when the draft is published between read and write", async () => {
    const tenant = forPrincipal(env.DB, {
      orgId: TEST_ORG_ID,
      userId: "owner",
      role: "owner",
    });

    let promoted = false;
    const racingTenant = {
      ...tenant,
      versions: {
        ...tenant.versions,
        async draft(id: string) {
          const read = await tenant.versions.draft(id);
          if (!promoted) {
            promoted = true;
            await publishDraft(tenant, id);
          }
          return read;
        },
      },
    };

    const res = await adminRoutes(
      new Request(`https://example.com/api/admin/assistants/${assistantId}/draft`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ behaviour: { greeting: "Stale save" } }),
      }),
      new URL(`https://example.com/api/admin/assistants/${assistantId}/draft`),
      {
        tenant: racingTenant,
        orgId: TEST_ORG_ID,
        docs: env.DOCS,
        queue: env.INGEST_QUEUE,
        retriever: { async remove() {} },
        publicBaseUrl: "https://example.com",
      },
    );
    expect(res.status).toBe(409);

    const rows = await tableVersions(assistantId);
    expect(rows).toHaveLength(2);
    const freshDraft = rows.find((r) => r.state === "draft");
    expect(JSON.parse(freshDraft?.config ?? "{}").behaviour.greeting).not.toBe("Stale save");
  });

  it("overlapping publishes return a handled conflict and preserve version invariants", async () => {
    await call(app, "PUT", `/api/admin/assistants/${assistantId}/draft`, {
      behaviour: { greeting: "Ready to publish" },
    });

    const tenant = forPrincipal(env.DB, {
      orgId: TEST_ORG_ID,
      userId: "owner",
      role: "owner",
    });

    let firstPublished: VersionRow | undefined;
    const racingTenant = {
      ...tenant,
      versions: {
        ...tenant.versions,
        async draft(id: string) {
          const read = await tenant.versions.draft(id);
          firstPublished = await publishDraft(tenant, id);
          return read;
        },
      },
    };

    const secondRes = await adminRoutes(
      new Request(`https://example.com/api/admin/assistants/${assistantId}/publish`, {
        method: "POST",
      }),
      new URL(`https://example.com/api/admin/assistants/${assistantId}/publish`),
      {
        tenant: racingTenant,
        orgId: TEST_ORG_ID,
        docs: env.DOCS,
        queue: env.INGEST_QUEUE,
        retriever: { async remove() {} },
        publicBaseUrl: "https://example.com",
      },
    );
    expect(secondRes.status).toBe(409);

    const rows = await tableVersions(assistantId);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.state === "published")).toHaveLength(1);
    expect(rows.filter((r) => r.state === "draft")).toHaveLength(1);
    expect(rows.filter((r) => r.state === "archived")).toHaveLength(0);
    expect(rows.find((r) => r.state === "published")?.id).toBe(firstPublished?.id);

    await expect(publishDraft(racingTenant, assistantId)).rejects.toBeInstanceOf(Conflict);
  });
});

function constantEmbedder(): ReturnType<typeof fakeEmbedder> {
  return {
    dimensions: 4,
    async embed(texts, onBilled) {
      await onBilled(texts.length * 4);
      return { vectors: texts.map(() => [1, 0, 0, 0]) };
    },
  };
}

function scriptedProvider(answerText: string): LlmProvider {
  return {
    name: "anthropic",
    model: ANTHROPIC_MODELS.fast.id,
    async *stream(): AsyncIterable<LlmChunk> {
      yield { kind: "text", text: answerText };
      yield { kind: "usage", tokensIn: 10, tokensOut: 5 };
    },
  };
}

describe("publish gate with answer tests", () => {
  let assistantId: string;

  async function seedChunk(retriever: ReturnType<typeof memoryRetriever>) {
    const sourceId = newId("src");
    const docId = newId("doc");
    const chunkId = newId("chk");
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO sources (id, org_id, assistant_id, kind, label, settings, created_at) VALUES (?1, ?2, ?3, 'push', 'Docs', '{}', ?4)",
      ).bind(sourceId, TEST_ORG_ID, assistantId, now),
      env.DB.prepare(
        "INSERT INTO documents (id, org_id, source_id, external_id, url, title, content_hash, updated_at) VALUES (?1, ?2, ?3, ?4, 'https://example.com/pricing', 'Pricing', 'hash', ?5)",
      ).bind(docId, TEST_ORG_ID, sourceId, docId, now),
      env.DB.prepare(
        "INSERT INTO chunks (id, org_id, document_id, ordinal, text, heading_path) VALUES (?1, ?2, ?3, 0, 'Pro costs $29.', '')",
      ).bind(chunkId, TEST_ORG_ID, docId),
    ]);
    await retriever.upsert([{ chunkId, vector: [1, 0, 0, 0], orgId: TEST_ORG_ID, assistantId }]);
  }

  function makeApp(answerText: string, retriever = memoryRetriever()) {
    return createApp(fakeSeams(), {
      chat: {
        embedder: constantEmbedder(),
        retriever,
        provider: scriptedProvider(answerText),
      },
    });
  }

  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM test_runs"),
      env.DB.prepare("DELETE FROM tests"),
      env.DB.prepare("DELETE FROM chunks"),
      env.DB.prepare("DELETE FROM documents"),
      env.DB.prepare("DELETE FROM sources"),
      env.DB.prepare("DELETE FROM assistant_versions"),
      env.DB.prepare("DELETE FROM assistants"),
    ]);

    const app = makeApp("Pro costs $29.");
    const res = await call(app, "POST", "/api/admin/assistants", {
      name: "Tested Bot",
      allowedOrigins: [],
    });
    const created = (await res.json()) as { assistant: AssistantRow };
    assistantId = created.assistant.id;
  });

  it("refuses publish with 409 and test results when a test fails, leaving assistant_versions untouched", async () => {
    const app = makeApp("Contact sales for pricing.");
    await call(app, "POST", `/api/admin/assistants/${assistantId}/tests`, {
      question: "What does Pro cost?",
      expectation: { kind: "contains", phrase: "$29" },
    });

    const versionsBefore = await tableVersions(assistantId);
    const res = await call(app, "POST", `/api/admin/assistants/${assistantId}/publish`);
    expect(res.status).toBe(409);

    const body = (await res.json()) as {
      error: string;
      run: { id: string; results: Array<{ outcome: string; reason: string }> };
    };
    expect(body.error).toBe("Some tests did not pass.");
    expect(body.run.results).toHaveLength(1);
    expect(body.run.results[0]?.outcome).toBe("failed");
    expect(body.run.results[0]?.reason).toBe('Did not say "$29".');

    const versionsAfter = await tableVersions(assistantId);
    expect(versionsAfter).toEqual(versionsBefore);
  });

  it("publishes with force: true when tests fail and records published_anyway = 1", async () => {
    const app = makeApp("Contact sales for pricing.");
    await call(app, "POST", `/api/admin/assistants/${assistantId}/tests`, {
      question: "What does Pro cost?",
      expectation: { kind: "contains", phrase: "$29" },
    });

    const res = await call(app, "POST", `/api/admin/assistants/${assistantId}/publish`, {
      force: true,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      version: VersionRow;
      run?: { id: string; passed: boolean };
    };
    expect(body.version.state).toBe("published");
    expect(body.run?.passed).toBe(false);

    const row = await env.DB.prepare("SELECT passed, published_anyway FROM test_runs WHERE id = ?1")
      .bind(body.run?.id)
      .first<{ passed: number; published_anyway: number }>();
    expect(row).toEqual({ passed: 0, published_anyway: 1 });
  });

  it("publishes normally when all tests pass and leaves published_anyway = 0", async () => {
    const app = makeApp("Pro costs $29 per month.");
    await call(app, "POST", `/api/admin/assistants/${assistantId}/tests`, {
      question: "What does Pro cost?",
      expectation: { kind: "declines" },
    });

    const res = await call(app, "POST", `/api/admin/assistants/${assistantId}/publish`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      version: VersionRow;
      run?: { id: string; passed: boolean };
    };
    expect(body.version.state).toBe("published");
    expect(body.run?.passed).toBe(true);

    const row = await env.DB.prepare("SELECT passed, published_anyway FROM test_runs WHERE id = ?1")
      .bind(body.run?.id)
      .first<{ passed: number; published_anyway: number }>();
    expect(row).toEqual({ passed: 1, published_anyway: 0 });
  });

  it("runs no tests when the assistant has no tests", async () => {
    const app = makeApp("Anything");
    const res = await call(app, "POST", `/api/admin/assistants/${assistantId}/publish`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { version: VersionRow; run?: unknown };
    expect(body.version.state).toBe("published");
    expect(body.run).toBeUndefined();

    const runs = await env.DB.prepare("SELECT COUNT(*) AS n FROM test_runs").first<{ n: number }>();
    expect(runs?.n).toBe(0);
  });

  it("rejects publish with 409 when the draft is edited while tests are running", async () => {
    let signalRunning!: () => void;
    const testRunning = new Promise<void>((resolve) => {
      signalRunning = resolve;
    });
    let releaseProvider!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });

    const retriever = memoryRetriever();
    await seedChunk(retriever);

    const app = createApp(fakeSeams(), {
      chat: {
        embedder: constantEmbedder(),
        retriever,
        provider: {
          name: "anthropic",
          model: ANTHROPIC_MODELS.fast.id,
          async *stream() {
            signalRunning();
            await gate;
            yield { kind: "text", text: "Pro costs $29." };
            yield { kind: "usage", tokensIn: 10, tokensOut: 5 };
          },
        },
      },
    });

    await call(app, "POST", `/api/admin/assistants/${assistantId}/tests`, {
      question: "What does Pro cost?",
      expectation: { kind: "contains", phrase: "$29" },
    });

    const publishPromise = call(app, "POST", `/api/admin/assistants/${assistantId}/publish`);
    await testRunning;

    const editRes = await call(app, "PUT", `/api/admin/assistants/${assistantId}/draft`, {
      behaviour: { greeting: "Untested greeting" },
    });
    expect(editRes.status).toBe(200);

    releaseProvider();
    const publishRes = await publishPromise;
    expect(publishRes.status).toBe(409);

    const rows = await tableVersions(assistantId);
    expect(rows.filter((r) => r.state === "published")).toHaveLength(0);
    const draft = rows.find((r) => r.state === "draft");
    expect(JSON.parse(draft?.config ?? "{}").behaviour.greeting).toBe("Untested greeting");
  });

  it("refuses with draft_changed when the confirmed draft is saved over while its tests run", async () => {
    let signalRunning!: () => void;
    const testRunning = new Promise<void>((resolve) => {
      signalRunning = resolve;
    });
    let releaseProvider!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const retriever = memoryRetriever();
    await seedChunk(retriever);
    const app = createApp(fakeSeams(), {
      chat: {
        embedder: constantEmbedder(),
        retriever,
        provider: {
          name: "anthropic",
          model: ANTHROPIC_MODELS.fast.id,
          async *stream() {
            signalRunning();
            await gate;
            yield { kind: "text", text: "Pro costs $29." };
            yield { kind: "usage", tokensIn: 10, tokensOut: 5 };
          },
        },
      },
    });
    await call(app, "POST", `/api/admin/assistants/${assistantId}/tests`, {
      question: "What does Pro cost?",
      expectation: { kind: "contains", phrase: "$29" },
    });
    const shown = (await (
      await call(app, "GET", `/api/admin/assistants/${assistantId}/draft`)
    ).json()) as { draft: VersionRow; revision: string };

    const publishPromise = call(app, "POST", `/api/admin/assistants/${assistantId}/publish`, {
      expected: { draftId: shown.draft.id, revision: shown.revision },
    });
    await testRunning;
    await call(app, "PUT", `/api/admin/assistants/${assistantId}/draft`, {
      behaviour: { greeting: "Untested greeting" },
    });
    releaseProvider();
    const publishRes = await publishPromise;
    expect(publishRes.status).toBe(409);
    expect(await publishRes.json()).toMatchObject({ code: "draft_changed" });
    expect((await tableVersions(assistantId)).filter((r) => r.state === "published")).toEqual([]);
  });

  it("records published_anyway = 1 on the reviewed run when force: true submits runId", async () => {
    let callCount = 0;
    const retriever = memoryRetriever();
    await seedChunk(retriever);

    const app = createApp(fakeSeams(), {
      chat: {
        embedder: constantEmbedder(),
        retriever,
        provider: {
          name: "anthropic",
          model: ANTHROPIC_MODELS.fast.id,
          async *stream() {
            callCount++;
            // Even if a second run would pass, submitting runId must not re-run
            // tests and must record the override on the inspected failing run.
            yield {
              kind: "text",
              text: callCount === 1 ? "Contact sales for pricing." : "Pro costs $29.",
            };
            yield { kind: "usage", tokensIn: 10, tokensOut: 5 };
          },
        },
      },
    });

    await call(app, "POST", `/api/admin/assistants/${assistantId}/tests`, {
      question: "What does Pro cost?",
      expectation: { kind: "contains", phrase: "$29" },
    });

    const firstRes = await call(app, "POST", `/api/admin/assistants/${assistantId}/publish`);
    expect(firstRes.status).toBe(409);
    const firstBody = (await firstRes.json()) as { run: { id: string } };
    const reviewedRunId = firstBody.run.id;

    const overrideRes = await call(app, "POST", `/api/admin/assistants/${assistantId}/publish`, {
      force: true,
      runId: reviewedRunId,
    });
    expect(overrideRes.status).toBe(200);
    const overrideBody = (await overrideRes.json()) as {
      version: VersionRow;
      run: { id: string; passed: boolean };
    };
    expect(overrideBody.version.state).toBe("published");
    expect(overrideBody.run).toEqual({ id: reviewedRunId, passed: false });
    expect(callCount).toBe(1);

    const runsCount = await env.DB.prepare("SELECT COUNT(*) AS n FROM test_runs").first<{
      n: number;
    }>();
    expect(runsCount?.n).toBe(1);

    const row = await env.DB.prepare("SELECT passed, published_anyway FROM test_runs WHERE id = ?1")
      .bind(reviewedRunId)
      .first<{ passed: number; published_anyway: number }>();
    expect(row).toEqual({ passed: 0, published_anyway: 1 });
  });

  it("rejects force: true with runId with 409 if the draft changed after the failing run", async () => {
    const app = makeApp("Contact sales for pricing.");
    await call(app, "POST", `/api/admin/assistants/${assistantId}/tests`, {
      question: "What does Pro cost?",
      expectation: { kind: "contains", phrase: "$29" },
    });

    const firstRes = await call(app, "POST", `/api/admin/assistants/${assistantId}/publish`);
    expect(firstRes.status).toBe(409);
    const firstBody = (await firstRes.json()) as { run: { id: string } };

    await call(app, "PUT", `/api/admin/assistants/${assistantId}/draft`, {
      behaviour: { greeting: "Changed after failing run" },
    });

    const overrideRes = await call(app, "POST", `/api/admin/assistants/${assistantId}/publish`, {
      force: true,
      runId: firstBody.run.id,
    });
    expect(overrideRes.status).toBe(409);

    const rows = await tableVersions(assistantId);
    expect(rows.filter((r) => r.state === "published")).toHaveLength(0);
    const runRow = await env.DB.prepare("SELECT published_anyway FROM test_runs WHERE id = ?1")
      .bind(firstBody.run.id)
      .first<{ published_anyway: number }>();
    expect(runRow?.published_anyway).toBe(0);
  });

  it("rejects force: true with a runId from another assistant with 404", async () => {
    const app = makeApp("Contact sales for pricing.");
    await call(app, "POST", `/api/admin/assistants/${assistantId}/tests`, {
      question: "What does Pro cost?",
      expectation: { kind: "contains", phrase: "$29" },
    });
    const firstRes = await call(app, "POST", `/api/admin/assistants/${assistantId}/publish`);
    expect(firstRes.status).toBe(409);
    const firstBody = (await firstRes.json()) as { run: { id: string } };

    const otherRes = await call(app, "POST", "/api/admin/assistants", {
      name: "Other Bot",
      allowedOrigins: [],
    });
    const other = (await otherRes.json()) as { assistant: AssistantRow };

    const overrideRes = await call(
      app,
      "POST",
      `/api/admin/assistants/${other.assistant.id}/publish`,
      { force: true, runId: firstBody.run.id },
    );
    expect(overrideRes.status).toBe(404);

    const runRow = await env.DB.prepare("SELECT published_anyway FROM test_runs WHERE id = ?1")
      .bind(firstBody.run.id)
      .first<{ published_anyway: number }>();
    expect(runRow?.published_anyway).toBe(0);
  });

  it("rejects force: true with runId with 409 when the run has no configHash (legacy run)", async () => {
    const app = makeApp("Contact sales for pricing.");
    const draftRes = await call(app, "GET", `/api/admin/assistants/${assistantId}/draft`);
    expect(draftRes.status).toBe(200);
    const { draft } = (await draftRes.json()) as { draft: VersionRow };

    const legacyRunId = newId("run");
    await env.DB.prepare(
      "INSERT INTO test_runs (id, org_id, version_id, started_at, results, passed, published_anyway, config_hash) VALUES (?1, ?2, ?3, ?4, ?5, 0, 0, NULL)",
    )
      .bind(legacyRunId, TEST_ORG_ID, draft.id, Date.now(), "[]")
      .run();

    await call(app, "PUT", `/api/admin/assistants/${assistantId}/draft`, {
      behaviour: { greeting: "Edited after legacy run" },
    });

    const overrideRes = await call(app, "POST", `/api/admin/assistants/${assistantId}/publish`, {
      force: true,
      runId: legacyRunId,
    });
    expect(overrideRes.status).toBe(409);

    const rows = await tableVersions(assistantId);
    expect(rows.filter((r) => r.state === "published")).toHaveLength(0);
    const runRow = await env.DB.prepare("SELECT published_anyway FROM test_runs WHERE id = ?1")
      .bind(legacyRunId)
      .first<{ published_anyway: number }>();
    expect(runRow?.published_anyway).toBe(0);
  });

  it("rolls back promotion when override recording fails for force: true with runId", async () => {
    const app = makeApp("Contact sales for pricing.");
    await call(app, "POST", `/api/admin/assistants/${assistantId}/tests`, {
      question: "What does Pro cost?",
      expectation: { kind: "contains", phrase: "$29" },
    });

    const firstRes = await call(app, "POST", `/api/admin/assistants/${assistantId}/publish`);
    expect(firstRes.status).toBe(409);
    const firstBody = (await firstRes.json()) as { run: { id: string } };
    const reviewedRunId = firstBody.run.id;

    await env.DB.prepare(
      `CREATE TRIGGER fail_override_update
       BEFORE UPDATE OF published_anyway ON test_runs
       BEGIN
         SELECT RAISE(ABORT, 'injected override failure');
       END`,
    ).run();

    try {
      await expect(
        call(app, "POST", `/api/admin/assistants/${assistantId}/publish`, {
          force: true,
          runId: reviewedRunId,
        }),
      ).rejects.toThrow(/injected override failure/);

      const rows = await tableVersions(assistantId);
      expect(rows).toHaveLength(1);
      expect(rows.filter((r) => r.state === "published")).toHaveLength(0);
      expect(rows.filter((r) => r.state === "draft")).toHaveLength(1);

      const runRow = await env.DB.prepare("SELECT published_anyway FROM test_runs WHERE id = ?1")
        .bind(reviewedRunId)
        .first<{ published_anyway: number }>();
      expect(runRow?.published_anyway).toBe(0);
    } finally {
      await env.DB.prepare("DROP TRIGGER IF EXISTS fail_override_update").run();
    }

    // Because promotion rolled back, the draft ID is unchanged and a retry succeeds.
    const retryRes = await call(app, "POST", `/api/admin/assistants/${assistantId}/publish`, {
      force: true,
      runId: reviewedRunId,
    });
    expect(retryRes.status).toBe(200);
    const rowsAfterRetry = await tableVersions(assistantId);
    expect(rowsAfterRetry.filter((r) => r.state === "published")).toHaveLength(1);
    const runRowAfterRetry = await env.DB.prepare(
      "SELECT published_anyway FROM test_runs WHERE id = ?1",
    )
      .bind(reviewedRunId)
      .first<{ published_anyway: number }>();
    expect(runRowAfterRetry?.published_anyway).toBe(1);
  });

  it("rolls back promotion when override recording fails for force: true without runId", async () => {
    const app = makeApp("Contact sales for pricing.");
    await call(app, "POST", `/api/admin/assistants/${assistantId}/tests`, {
      question: "What does Pro cost?",
      expectation: { kind: "contains", phrase: "$29" },
    });

    await env.DB.prepare(
      `CREATE TRIGGER fail_override_update
       BEFORE UPDATE OF published_anyway ON test_runs
       BEGIN
         SELECT RAISE(ABORT, 'injected override failure');
       END`,
    ).run();

    try {
      await expect(
        call(app, "POST", `/api/admin/assistants/${assistantId}/publish`, { force: true }),
      ).rejects.toThrow(/injected override failure/);

      const rows = await tableVersions(assistantId);
      expect(rows).toHaveLength(1);
      expect(rows.filter((r) => r.state === "published")).toHaveLength(0);
      expect(rows.filter((r) => r.state === "draft")).toHaveLength(1);

      const runRow = await env.DB.prepare(
        "SELECT passed, published_anyway FROM test_runs ORDER BY started_at DESC LIMIT 1",
      ).first<{ passed: number; published_anyway: number }>();
      expect(runRow).toEqual({ passed: 0, published_anyway: 0 });
    } finally {
      await env.DB.prepare("DROP TRIGGER IF EXISTS fail_override_update").run();
    }
  });

  it("leaves published_anyway = 0 when a concurrent publish beats force: true with runId", async () => {
    const app = makeApp("Contact sales for pricing.");
    await call(app, "POST", `/api/admin/assistants/${assistantId}/tests`, {
      question: "What does Pro cost?",
      expectation: { kind: "contains", phrase: "$29" },
    });

    const firstRes = await call(app, "POST", `/api/admin/assistants/${assistantId}/publish`);
    expect(firstRes.status).toBe(409);
    const firstBody = (await firstRes.json()) as { run: { id: string } };
    const reviewedRunId = firstBody.run.id;

    const tenant = forPrincipal(env.DB, {
      orgId: TEST_ORG_ID,
      userId: "owner",
      role: "owner",
    });

    // Freeze time so both the racing normal publish and the force batch get the same published_at.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 5_000);
    try {
      const racingTenant = {
        ...tenant,
        versions: {
          ...tenant.versions,
          async draft(id: string) {
            const read = await tenant.versions.draft(id);
            await publishDraft(tenant, id);
            return read;
          },
        },
      };

      const res = await adminRoutes(
        new Request(`https://example.com/api/admin/assistants/${assistantId}/publish`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ force: true, runId: reviewedRunId }),
        }),
        new URL(`https://example.com/api/admin/assistants/${assistantId}/publish`),
        {
          tenant: racingTenant,
          orgId: TEST_ORG_ID,
          docs: env.DOCS,
          queue: env.INGEST_QUEUE,
          retriever: { async remove() {} },
          publicBaseUrl: "https://example.com",
        },
      );
      expect(res.status).toBe(409);

      const runRow = await env.DB.prepare("SELECT published_anyway FROM test_runs WHERE id = ?1")
        .bind(reviewedRunId)
        .first<{ published_anyway: number }>();
      expect(runRow?.published_anyway).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves published_anyway = 0 when the draft is edited during force: true without runId", async () => {
    let signalRunning!: () => void;
    const testRunning = new Promise<void>((resolve) => {
      signalRunning = resolve;
    });
    let releaseProvider!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });

    const retriever = memoryRetriever();
    await seedChunk(retriever);

    const app = createApp(fakeSeams(), {
      chat: {
        embedder: constantEmbedder(),
        retriever,
        provider: {
          name: "anthropic",
          model: ANTHROPIC_MODELS.fast.id,
          async *stream() {
            signalRunning();
            await gate;
            yield { kind: "text", text: "Contact sales for pricing." };
            yield { kind: "usage", tokensIn: 10, tokensOut: 5 };
          },
        },
      },
    });

    await call(app, "POST", `/api/admin/assistants/${assistantId}/tests`, {
      question: "What does Pro cost?",
      expectation: { kind: "contains", phrase: "$29" },
    });

    const publishPromise = call(app, "POST", `/api/admin/assistants/${assistantId}/publish`, {
      force: true,
    });
    await testRunning;

    const editRes = await call(app, "PUT", `/api/admin/assistants/${assistantId}/draft`, {
      behaviour: { greeting: "Edited mid-force-run" },
    });
    expect(editRes.status).toBe(200);

    releaseProvider();
    const publishRes = await publishPromise;
    expect(publishRes.status).toBe(409);

    const rows = await tableVersions(assistantId);
    expect(rows.filter((r) => r.state === "published")).toHaveLength(0);
    const runRow = await env.DB.prepare(
      "SELECT passed, published_anyway FROM test_runs ORDER BY started_at DESC LIMIT 1",
    ).first<{ passed: number; published_anyway: number }>();
    expect(runRow).toEqual({ passed: 0, published_anyway: 0 });
  });
});
