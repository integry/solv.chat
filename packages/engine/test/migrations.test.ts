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
  "conversations",
  "messages",
  "feedback",
  "mcp_servers",
  "mcp_tools",
  "tests",
  "test_runs",
  "gap_answers",
  "assistant_origins",
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

  it("backfills reply links and question keys for rows written before 0007", async () => {
    const orgId = "org_00000000000000000000";
    const legacy = (id: string, role: string, content: string, at: number) =>
      env.DB.prepare(
        "INSERT INTO messages (id, org_id, conversation_id, role, content, created_at) VALUES (?1, ?2, 'cnv_1', ?3, ?4, ?5)",
      ).bind(id, orgId, role, content, at);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO assistants (id, org_id, name, public_key, created_at) VALUES ('ast_1', ?1, 'Site', 'pk_1', 1)",
      ).bind(orgId),
      env.DB.prepare(
        "INSERT INTO conversations (id, org_id, assistant_id, visitor_id, started_at, page_url) VALUES ('cnv_1', ?1, 'ast_1', 'vis', 1, '')",
      ).bind(orgId),
      // Ids sort opposite to insertion, and the first reply shares its
      // question's millisecond: only insertion order tells them apart.
      legacy("msg_z", "user", "First?", 100),
      legacy("msg_y", "assistant", "Reply one", 100),
      legacy("msg_x", "user", "  Hello\t\n  World    again?  ", 200),
      legacy("msg_w", "assistant", "Reply two", 300),
    ]);

    const migration = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0007_"));
    const updates = (migration?.queries ?? []).filter((q) => /^\s*UPDATE\b/i.test(q));
    expect(updates.length).toBeGreaterThan(0);
    for (const sql of updates) {
      await env.DB.prepare(sql).run();
    }

    const rows = await env.DB.prepare(
      "SELECT id, reply_to, question_key FROM messages WHERE org_id = ?1 ORDER BY rowid",
    )
      .bind(orgId)
      .all<{ id: string; reply_to: string | null; question_key: string | null }>();
    expect(rows.results).toEqual([
      { id: "msg_z", reply_to: null, question_key: "first?" },
      { id: "msg_y", reply_to: "msg_z", question_key: null },
      { id: "msg_x", reply_to: null, question_key: "hello world again?" },
      { id: "msg_w", reply_to: "msg_x", question_key: null },
    ]);
  });
});
