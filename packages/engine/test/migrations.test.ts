import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

const EXPECTED_TABLES = [
  "orgs",
  "usage_daily",
  "rate_counters",
  "login_failures",
  "assistants",
  "assistant_versions",
  "sources",
  "documents",
  "chunks",
  "pending_vectors",
  "stale_vectors",
  "stale_objects",
  "conversations",
  "messages",
  "feedback",
  "mcp_servers",
  "mcp_tools",
  "tests",
  "test_runs",
];

describe("migrations", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM test_runs"),
      env.DB.prepare("DELETE FROM tests"),
      env.DB.prepare("DELETE FROM mcp_tools"),
      env.DB.prepare("DELETE FROM mcp_servers"),
      env.DB.prepare("DELETE FROM feedback"),
      env.DB.prepare("DELETE FROM messages"),
      env.DB.prepare("DELETE FROM conversations"),
      env.DB.prepare("DELETE FROM chunks"),
      env.DB.prepare("DELETE FROM documents"),
      env.DB.prepare("DELETE FROM sources"),
      env.DB.prepare("DELETE FROM assistant_versions"),
      env.DB.prepare("DELETE FROM assistants"),
      env.DB.prepare("DELETE FROM orgs WHERE id != 'org_00000000000000000000'"),
    ]);
  });

  it("creates every table from the data model", async () => {
    const res = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations'",
    ).all<{ name: string }>();

    const tableNames = res.results.map((r) => r.name);
    for (const expected of EXPECTED_TABLES) {
      expect(tableNames).toContain(expected);
    }
  });

  it("rejects a second draft version for the same assistant", async () => {
    const orgId = "org_00000000000000000000";
    await env.DB.prepare(
      "INSERT INTO assistants (id, org_id, name, public_key, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
    )
      .bind("ast_1", orgId, "Site A", "pk_1", 1000)
      .run();

    await env.DB.prepare(
      "INSERT INTO assistant_versions (id, org_id, assistant_id, state, config, created_at) VALUES (?1, ?2, ?3, 'draft', '{}', ?4)",
    )
      .bind("ver_1", orgId, "ast_1", 1000)
      .run();

    await expect(
      env.DB.prepare(
        "INSERT INTO assistant_versions (id, org_id, assistant_id, state, config, created_at) VALUES (?1, ?2, ?3, 'draft', '{}', ?4)",
      )
        .bind("ver_2", orgId, "ast_1", 1001)
        .run(),
    ).rejects.toThrow();
  });

  it("rejects a second published version for the same assistant", async () => {
    const orgId = "org_00000000000000000000";
    await env.DB.prepare(
      "INSERT INTO assistants (id, org_id, name, public_key, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
    )
      .bind("ast_1", orgId, "Site A", "pk_1", 1000)
      .run();

    await env.DB.prepare(
      "INSERT INTO assistant_versions (id, org_id, assistant_id, state, config, created_at, published_at) VALUES (?1, ?2, ?3, 'published', '{}', ?4, ?5)",
    )
      .bind("ver_1", orgId, "ast_1", 1000, 1000)
      .run();

    await expect(
      env.DB.prepare(
        "INSERT INTO assistant_versions (id, org_id, assistant_id, state, config, created_at, published_at) VALUES (?1, ?2, ?3, 'published', '{}', ?4, ?5)",
      )
        .bind("ver_2", orgId, "ast_1", 1001, 1001)
        .run(),
    ).rejects.toThrow();
  });

  it("allows two assistants to each have a draft", async () => {
    const orgId = "org_00000000000000000000";
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO assistants (id, org_id, name, public_key, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
      ).bind("ast_1", orgId, "Site A", "pk_1", 1000),
      env.DB.prepare(
        "INSERT INTO assistants (id, org_id, name, public_key, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
      ).bind("ast_2", orgId, "Site B", "pk_2", 1000),
      env.DB.prepare(
        "INSERT INTO assistant_versions (id, org_id, assistant_id, state, config, created_at) VALUES (?1, ?2, ?3, 'draft', '{}', ?4)",
      ).bind("ver_1", orgId, "ast_1", 1000),
      env.DB.prepare(
        "INSERT INTO assistant_versions (id, org_id, assistant_id, state, config, created_at) VALUES (?1, ?2, ?3, 'draft', '{}', ?4)",
      ).bind("ver_2", orgId, "ast_2", 1000),
    ]);

    const drafts = await env.DB.prepare(
      "SELECT id FROM assistant_versions WHERE state = 'draft' ORDER BY id",
    ).all<{ id: string }>();
    expect(drafts.results.map((r) => r.id)).toEqual(["ver_1", "ver_2"]);
  });

  it("rejects duplicate (org_id, source_id, external_id) in documents", async () => {
    const orgId = "org_00000000000000000000";
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO assistants (id, org_id, name, public_key, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
      ).bind("ast_1", orgId, "Site A", "pk_1", 1000),
      env.DB.prepare(
        "INSERT INTO sources (id, org_id, assistant_id, kind, label, created_at) VALUES (?1, ?2, ?3, 'push', 'Docs', ?4)",
      ).bind("src_1", orgId, "ast_1", 1000),
      env.DB.prepare(
        "INSERT INTO documents (id, org_id, source_id, external_id, url, title, content_hash, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
      ).bind("doc_1", orgId, "src_1", "getting-started", "https://a.test/gs", "GS", "h1", 1000),
    ]);

    await expect(
      env.DB.prepare(
        "INSERT INTO documents (id, org_id, source_id, external_id, url, title, content_hash, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
      )
        .bind("doc_2", orgId, "src_1", "getting-started", "https://a.test/gs", "GS", "h2", 1001)
        .run(),
    ).rejects.toThrow();
  });
});
