import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { forPrincipal } from "../../src/db/tenant.js";

const ORG_ID = "org_00000000000000000000";
const OTHER_ORG = "org_bulkbulkbulkbulkbulk";
// More than two IN-list groups of 98 (D1 allows 100 bound parameters).
const TOTAL = 230;

describe("db/documents bulk delete", () => {
  const tenant = forPrincipal(env.DB, { orgId: ORG_ID, userId: "owner", role: "owner" });

  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM chunks"),
      env.DB.prepare("DELETE FROM documents"),
      env.DB.prepare("DELETE FROM sources"),
      env.DB.prepare("DELETE FROM assistants"),
      env.DB.prepare("INSERT OR IGNORE INTO orgs (id, name) VALUES (?1, 'Other')").bind(OTHER_ORG),
    ]);
    const statements: D1PreparedStatement[] = [];
    for (const orgId of [ORG_ID, OTHER_ORG]) {
      statements.push(
        env.DB.prepare(
          "INSERT INTO assistants (id, org_id, name, public_key, created_at) VALUES (?1, ?2, 'A', ?3, 1)",
        ).bind(`ast_${orgId}`, orgId, `pk_${orgId}`),
        env.DB.prepare(
          "INSERT INTO sources (id, org_id, assistant_id, kind, label, created_at) VALUES (?1, ?2, ?3, 'push', 'CLI', 1)",
        ).bind(`src_${orgId}`, orgId, `ast_${orgId}`),
      );
    }
    for (let i = 0; i < TOTAL; i++) {
      statements.push(
        env.DB.prepare(
          "INSERT INTO documents (id, org_id, source_id, external_id, url, title, content_hash, updated_at) VALUES (?1, ?2, ?3, ?4, '', '', 'h', 1)",
        ).bind(`doc_${i}`, ORG_ID, `src_${ORG_ID}`, `ext-${i}`),
        env.DB.prepare(
          "INSERT INTO chunks (id, org_id, document_id, ordinal, text) VALUES (?1, ?2, ?3, 0, 't'), (?4, ?2, ?3, 1, 't')",
        ).bind(`chk_${i}_a`, ORG_ID, `doc_${i}`, `chk_${i}_b`),
      );
    }
    // Another org's document with an id the caller also names.
    statements.push(
      env.DB.prepare(
        "INSERT INTO documents (id, org_id, source_id, external_id, url, title, content_hash, updated_at) VALUES ('doc_other', ?1, ?2, 'ext-0', '', '', 'h', 1)",
      ).bind(OTHER_ORG, `src_${OTHER_ORG}`),
    );
    for (let i = 0; i < statements.length; i += 100) {
      await env.DB.batch(statements.slice(i, i + 100));
    }
  });

  it("finds documents by external id past one IN-list group, inside the org and source only", async () => {
    const wanted = Array.from({ length: TOTAL }, (_, i) => `ext-${i}`);
    const found = await tenant.documents.getByExternalIds(`src_${ORG_ID}`, [...wanted, "ext-none"]);
    expect(found.map((d) => d.externalId).sort()).toEqual([...wanted].sort());
    expect(found.every((d) => d.orgId === ORG_ID)).toBe(true);
    expect(await tenant.documents.getByExternalIds(`src_${ORG_ID}`, [])).toEqual([]);
  });

  it("removes every document with its chunk ids in one call, and nothing of another org", async () => {
    const ids = [...Array.from({ length: TOTAL }, (_, i) => `doc_${i}`), "doc_other", "doc_none"];
    const removed = await tenant.documents.removeMany(ids);

    expect(removed.size).toBe(TOTAL);
    expect(removed.has("doc_other")).toBe(false);
    expect(removed.get("doc_7")?.sort()).toEqual(["chk_7_a", "chk_7_b"]);
    expect([...removed.values()].flat()).toHaveLength(TOTAL * 2);

    const left = await env.DB.prepare(
      "SELECT (SELECT COUNT(*) FROM documents) AS docs, (SELECT COUNT(*) FROM chunks) AS chunks",
    ).first<{ docs: number; chunks: number }>();
    expect(left).toEqual({ docs: 1, chunks: 0 });
  });
});
