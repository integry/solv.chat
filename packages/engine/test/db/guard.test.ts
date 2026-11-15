import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { prepare, prepareInsert } from "../../src/db/sql.js";

describe("sql guard", () => {
  it("throws for a statement without org_id = ?1 and names the statement", () => {
    const sql = "SELECT id, name FROM assistants WHERE id = ?1";
    expect(() => prepare(env.DB, sql)).toThrowError(/org_id = \?1/);
    expect(() => prepare(env.DB, sql)).toThrowError(
      /SELECT id, name FROM assistants WHERE id = \?1/,
    );
  });

  it("throws when org_id is compared to a different placeholder", () => {
    const sql = "DELETE FROM assistants WHERE id = ?1 AND org_id = ?2";
    expect(() => prepare(env.DB, sql)).toThrowError(/org_id = \?1/);
  });

  it("passes a statement that filters on org_id = ?1", () => {
    const stmt = prepare(env.DB, "SELECT id FROM assistants WHERE org_id = ?1 AND id = ?2");
    expect(stmt).toBeDefined();
  });

  it.each([
    ["a line comment", "SELECT id FROM assistants WHERE id = ?2 -- org_id = ?1"],
    ["a block comment", "SELECT id FROM assistants /* org_id = ?1 */ WHERE id = ?2"],
    ["a string literal", "SELECT id FROM assistants WHERE name = 'org_id = ?1' AND id = ?2"],
    ["a quoted alias", 'SELECT id AS "org_id = ?1" FROM assistants WHERE id = ?2'],
  ])("throws when the only org_id = ?1 is inside %s", (_label, sql) => {
    expect(() => prepare(env.DB, sql)).toThrowError(/org_id = \?1/);
  });

  it.each([
    ["a top-level OR", "SELECT id FROM assistants WHERE org_id = ?1 OR 1 = 1"],
    ["an OR before the filter", "DELETE FROM assistants WHERE id = ?2 OR org_id = ?1"],
    ["an OR in the filter's own group", "SELECT id FROM assistants WHERE (org_id = ?1 OR id = ?2)"],
    [
      "an OR in an enclosing group",
      "UPDATE assistants SET name = ?2 WHERE id = ?3 AND ((org_id = ?1 AND name = ?4) or 1 = 1)",
    ],
  ])("throws when %s can bypass org_id = ?1", (_label, sql) => {
    expect(() => prepare(env.DB, sql)).toThrowError(/org_id = \?1/);
  });

  it.each([
    [
      "an OR nested inside an AND with the filter",
      "UPDATE documents SET title = ?2 WHERE org_id = ?1 AND (indexed_hash IS NULL OR indexed_hash != ?3)",
    ],
    [
      "a second, bypassable copy beside a sound one",
      "SELECT id FROM assistants WHERE org_id = ?1 AND id IN (SELECT id FROM assistants WHERE org_id = ?1 OR id = ?2)",
    ],
    [
      "a conflict clause spelled with OR",
      "UPDATE OR IGNORE assistants SET name = ?2 WHERE org_id = ?1 AND id = ?3",
    ],
    ["a comment beside a real filter", "SELECT id FROM assistants -- tenant\nWHERE org_id = ?1"],
  ])("passes %s", (_label, sql) => {
    expect(prepare(env.DB, sql)).toBeDefined();
  });

  it("throws from prepareInsert when org_id is not among the columns", () => {
    const sql = "INSERT INTO assistants (id, name, public_key, created_at) VALUES (?1, ?2, ?3, ?4)";
    expect(() => prepareInsert(env.DB, sql)).toThrowError(/org_id/);
    expect(() => prepareInsert(env.DB, sql)).toThrowError(/INSERT INTO assistants/);
  });

  it("passes prepareInsert when org_id is among the columns", () => {
    const stmt = prepareInsert(
      env.DB,
      "INSERT INTO assistants (id, org_id, name, public_key, created_at) VALUES (?2, ?1, ?3, ?4, ?5)",
    );
    expect(stmt).toBeDefined();
  });
});
