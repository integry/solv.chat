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
