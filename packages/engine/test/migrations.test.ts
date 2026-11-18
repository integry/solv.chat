import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { searchableText } from "../src/db/messages.js";

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
  "source_syncs",
  "source_sync_pages",
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

  it("folds ASCII rows written before 0019 exactly as the engine does, and only those", async () => {
    const orgId = "org_00000000000000000000";
    // Every ASCII whitespace character, other control characters and letters
    // in both cases, in runs, from a fixed seed.
    const alphabet = ["a", "B", "z", "Q", "?", "1", " ", "\t", "\n", "\v", "\f", "\r", "\x1c"];
    let seed = 7;
    const generated = Array.from({ length: 40 }, () => {
      let text = "";
      for (let i = 0; i < 30; i++) {
        seed = (seed * 1103515245 + 12345) % 2 ** 31;
        const char = alphabet[seed % alphabet.length] ?? "";
        text += char.repeat(1 + (seed % 3));
      }
      return text;
    });
    const ascii = [
      "  Do  YOU\tship?\r\n\nTo SPAIN?  ",
      "\vVertical\fform feed",
      "Unit\x1fseparator stays",
      `x${" ".repeat(256)}y`,
      ...generated,
    ];
    const forTheEngine = [
      // More spaces in a row than eight passes collapse.
      `x${" ".repeat(300)}y`,
      "Où est l'École?",
      "Curly ’quotes’ only",
      "Do you\u00a0ship?",
    ];
    const contents = [...ascii, ...forTheEngine];
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO assistants (id, org_id, name, public_key, created_at) VALUES ('ast_1', ?1, 'Site', 'pk_1', 1)",
      ).bind(orgId),
      env.DB.prepare(
        "INSERT INTO conversations (id, org_id, assistant_id, visitor_id, started_at, page_url) VALUES ('cnv_1', ?1, 'ast_1', 'vis', 1, '')",
      ).bind(orgId),
      ...contents.map((content, i) =>
        env.DB.prepare(
          "INSERT INTO messages (id, org_id, conversation_id, role, content, created_at) VALUES (?1, ?2, 'cnv_1', 'assistant', ?3, ?4)",
        ).bind(`msg_${i}`, orgId, content, i),
      ),
    ]);

    const migration = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0019_"));
    // The backfill's own updates, not the trigger's body.
    const updates = (migration?.queries ?? []).filter(
      (q) =>
        /\bUPDATE\s+messages\s+SET\s+search_text\b/i.test(q) && !/\bCREATE\s+TRIGGER\b/i.test(q),
    );
    // One statement: a large table is read once.
    expect(updates.length).toBe(1);
    for (const sql of updates) {
      await env.DB.prepare(sql).run();
    }

    const rows = await env.DB.prepare(
      "SELECT content, search_text FROM messages WHERE org_id = ?1 ORDER BY created_at",
    )
      .bind(orgId)
      .all<{ content: string; search_text: string | null }>();
    expect(rows.results).toEqual([
      ...ascii.map((content) => ({ content, search_text: searchableText(content) })),
      ...forTheEngine.map((content) => ({ content, search_text: null })),
    ]);
  });

  it("drops search_text when content is rewritten without it, as an older Worker does", async () => {
    const orgId = "org_00000000000000000000";
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO assistants (id, org_id, name, public_key, created_at) VALUES ('ast_1', ?1, 'Site', 'pk_1', 1)",
      ).bind(orgId),
      env.DB.prepare(
        "INSERT INTO conversations (id, org_id, assistant_id, visitor_id, started_at, page_url) VALUES ('cnv_1', ?1, 'ast_1', 'vis', 1, '')",
      ).bind(orgId),
      ...["msg_old", "msg_new", "msg_same"].map((id, i) =>
        env.DB.prepare(
          "INSERT INTO messages (id, org_id, conversation_id, role, content, search_text, created_at) VALUES (?1, ?2, 'cnv_1', 'assistant', 'Paused', 'paused', ?3)",
        ).bind(id, orgId, i),
      ),
    ]);

    await env.DB.batch([
      // An older Worker completes a paused reply: content only.
      env.DB.prepare(
        "UPDATE messages SET content = 'Paused, then École' WHERE org_id = ?1 AND id = 'msg_old'",
      ).bind(orgId),
      // The engine writes both together.
      env.DB.prepare(
        "UPDATE messages SET content = ?2, search_text = ?3 WHERE org_id = ?1 AND id = 'msg_new'",
      ).bind(orgId, "Paused, then École", searchableText("Paused, then École")),
      // A write that leaves content as it was changes nothing.
      env.DB.prepare(
        "UPDATE messages SET content = 'Paused' WHERE org_id = ?1 AND id = 'msg_same'",
      ).bind(orgId),
    ]);

    const rows = await env.DB.prepare(
      "SELECT id, search_text FROM messages WHERE org_id = ?1 ORDER BY created_at",
    )
      .bind(orgId)
      .all<{ id: string; search_text: string | null }>();
    expect(rows.results).toEqual([
      { id: "msg_old", search_text: null },
      { id: "msg_new", search_text: "paused, then école" },
      { id: "msg_same", search_text: "paused" },
    ]);
  });

  it("folds final sigma in text folded before 0020, and leaves other text alone", async () => {
    const orgId = "org_00000000000000000000";
    const stored = [
      ["msg_greek", "Ο ΚΌΣΜΟΣ ΜΑΣ", "ο κόσμος μας"],
      ["msg_ascii", "Do you ship?", "do you ship?"],
      ["msg_pending", "Ο ΚΌΣΜΟΣ", null],
    ] as const;
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO assistants (id, org_id, name, public_key, created_at) VALUES ('ast_1', ?1, 'Site', 'pk_1', 1)",
      ).bind(orgId),
      env.DB.prepare(
        "INSERT INTO conversations (id, org_id, assistant_id, visitor_id, started_at, page_url) VALUES ('cnv_1', ?1, 'ast_1', 'vis', 1, '')",
      ).bind(orgId),
      ...stored.map(([id, content, searchText], i) =>
        env.DB.prepare(
          "INSERT INTO messages (id, org_id, conversation_id, role, content, search_text, created_at) VALUES (?1, ?2, 'cnv_1', 'user', ?3, ?4, ?5)",
        ).bind(id, orgId, content, searchText, i),
      ),
    ]);

    const migration = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0020_"));
    expect(migration?.queries.length).toBe(1);
    for (const sql of migration?.queries ?? []) await env.DB.prepare(sql).run();

    const rows = await env.DB.prepare(
      "SELECT id, content, search_text FROM messages WHERE org_id = ?1 ORDER BY created_at",
    )
      .bind(orgId)
      .all<{ id: string; content: string; search_text: string | null }>();
    expect(rows.results).toEqual([
      { id: "msg_greek", content: "Ο ΚΌΣΜΟΣ ΜΑΣ", search_text: searchableText("Ο ΚΌΣΜΟΣ ΜΑΣ") },
      { id: "msg_ascii", content: "Do you ship?", search_text: "do you ship?" },
      { id: "msg_pending", content: "Ο ΚΌΣΜΟΣ", search_text: null },
    ]);
    expect(rows.results[0]?.search_text).toBe("ο κόσμοσ μασ");
  });

  it("keeps each conversation's newest message time, from 0021's backfill and triggers", async () => {
    const orgId = "org_00000000000000000000";
    const lastMessageAt = async () => {
      const res = await env.DB.prepare(
        "SELECT id, last_message_at FROM conversations WHERE org_id = ?1 ORDER BY id",
      )
        .bind(orgId)
        .all<{ id: string; last_message_at: number | null }>();
      return Object.fromEntries(res.results.map((r) => [r.id, r.last_message_at]));
    };
    const insertMessage = (id: string, conversation: string, at: number) =>
      env.DB.prepare(
        "INSERT INTO messages (id, org_id, conversation_id, role, content, created_at) VALUES (?1, ?2, ?3, 'user', 'Hi', ?4)",
      ).bind(id, orgId, conversation, at);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO assistants (id, org_id, name, public_key, created_at) VALUES ('ast_1', ?1, 'Site', 'pk_1', 1)",
      ).bind(orgId),
      // Written the way an older Worker writes them: no last_message_at.
      ...["cnv_a", "cnv_b"].map((id) =>
        env.DB.prepare(
          "INSERT INTO conversations (id, org_id, assistant_id, visitor_id, started_at, page_url) VALUES (?1, ?2, 'ast_1', 'vis', 100, '')",
        ).bind(id, orgId),
      ),
    ]);
    // A conversation starts at its start time.
    expect(await lastMessageAt()).toEqual({ cnv_a: 100, cnv_b: 100 });

    await env.DB.batch([
      insertMessage("msg_1", "cnv_a", 300),
      // Written later with an earlier time: the newest time stays.
      insertMessage("msg_2", "cnv_a", 200),
    ]);
    expect(await lastMessageAt()).toEqual({ cnv_a: 300, cnv_b: 100 });

    await env.DB.prepare("DELETE FROM messages WHERE org_id = ?1 AND id = 'msg_1'")
      .bind(orgId)
      .run();
    expect(await lastMessageAt()).toEqual({ cnv_a: 200, cnv_b: 100 });
    await env.DB.prepare("DELETE FROM messages WHERE org_id = ?1 AND id = 'msg_2'")
      .bind(orgId)
      .run();
    expect(await lastMessageAt()).toEqual({ cnv_a: 100, cnv_b: 100 });

    // The backfill, over rows from before the column existed.
    await env.DB.batch([
      insertMessage("msg_3", "cnv_b", 50),
      insertMessage("msg_4", "cnv_b", 70),
      env.DB.prepare("UPDATE conversations SET last_message_at = NULL WHERE org_id = ?1").bind(
        orgId,
      ),
    ]);
    const migration = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0021_"));
    const backfill = (migration?.queries ?? []).filter(
      (q) => /^\s*UPDATE\s+conversations\b/i.test(q) && !/\bCREATE\s+TRIGGER\b/i.test(q),
    );
    expect(backfill.length).toBe(1);
    for (const sql of backfill) await env.DB.prepare(sql).run();
    // The newest message, even one older than the start; the start without one.
    expect(await lastMessageAt()).toEqual({ cnv_a: 100, cnv_b: 70 });
  });

  it("uses unique, sequential numeric prefixes for every migration", () => {
    const names = env.TEST_MIGRATIONS.map((m) => m.name);
    const prefixes = names.map((name) => {
      const match = /^(\d{4})_/.exec(name);
      expect(match, `Migration ${name} must start with a 4-digit prefix`).not.toBeNull();
      return match?.[1] ?? "";
    });

    expect(new Set(prefixes).size).toBe(prefixes.length);
    for (let i = 0; i < prefixes.length; i++) {
      expect(Number(prefixes[i])).toBe(i + 1);
    }
  });
});
