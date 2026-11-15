import { prepare, prepareInsert, safeJsonArray, safeJsonObject } from "./sql.js";

interface TestDbRow {
  id: string;
  org_id: string;
  assistant_id: string;
  question: string;
  expectation: string;
  created_at: number;
}

interface TestRunDbRow {
  id: string;
  org_id: string;
  version_id: string;
  started_at: number;
  results: string;
  passed: number;
}

export interface TestRow {
  id: string;
  orgId: string;
  assistantId: string;
  question: string;
  expectation: Record<string, unknown>;
  createdAt: number;
}

export interface TestRunRow {
  id: string;
  orgId: string;
  versionId: string;
  startedAt: number;
  results: unknown[];
  passed: boolean;
}

export interface CreateTestInput {
  id: string;
  assistantId: string;
  question: string;
  expectation: Record<string, unknown>;
  createdAt: number;
}

export interface CreateTestRunInput {
  id: string;
  versionId: string;
  startedAt: number;
  results: unknown[];
  passed: boolean;
}

const TEST_COLUMNS = "id, org_id, assistant_id, question, expectation, created_at";
const RUN_COLUMNS = "id, org_id, version_id, started_at, results, passed";

const mapTest = (row: TestDbRow): TestRow => ({
  id: row.id,
  orgId: row.org_id,
  assistantId: row.assistant_id,
  question: row.question,
  expectation: safeJsonObject(row.expectation),
  createdAt: row.created_at,
});

const mapRun = (row: TestRunDbRow): TestRunRow => ({
  id: row.id,
  orgId: row.org_id,
  versionId: row.version_id,
  startedAt: row.started_at,
  results: safeJsonArray<unknown>(row.results),
  passed: row.passed === 1,
});

/** Tenant-scoped data access for `tests` and `test_runs`. */
export function testsFor(db: D1Database, orgId: string) {
  return {
    async list(assistantId: string): Promise<TestRow[]> {
      const res = await prepare(
        db,
        `SELECT ${TEST_COLUMNS} FROM tests WHERE org_id = ?1 AND assistant_id = ?2 ORDER BY created_at ASC`,
      )
        .bind(orgId, assistantId)
        .all<TestDbRow>();
      return res.results.map(mapTest);
    },

    async get(id: string): Promise<TestRow | null> {
      const row = await prepare(
        db,
        `SELECT ${TEST_COLUMNS} FROM tests WHERE org_id = ?1 AND id = ?2`,
      )
        .bind(orgId, id)
        .first<TestDbRow>();
      return row ? mapTest(row) : null;
    },

    async create(input: CreateTestInput): Promise<TestRow> {
      await prepareInsert(
        db,
        `INSERT INTO tests (id, org_id, assistant_id, question, expectation, created_at)
         VALUES (?2, ?1, ?3, ?4, ?5, ?6)`,
      )
        .bind(
          orgId,
          input.id,
          input.assistantId,
          input.question,
          JSON.stringify(input.expectation),
          input.createdAt,
        )
        .run();

      return {
        id: input.id,
        orgId,
        assistantId: input.assistantId,
        question: input.question,
        expectation: input.expectation,
        createdAt: input.createdAt,
      };
    },

    async updateQuestion(id: string, question: string): Promise<boolean> {
      const res = await prepare(db, "UPDATE tests SET question = ?3 WHERE org_id = ?1 AND id = ?2")
        .bind(orgId, id, question)
        .run();
      return (res.meta.changes ?? 0) > 0;
    },

    async remove(id: string): Promise<boolean> {
      const res = await prepare(db, "DELETE FROM tests WHERE org_id = ?1 AND id = ?2")
        .bind(orgId, id)
        .run();
      return (res.meta.changes ?? 0) > 0;
    },

    async listRuns(versionId: string): Promise<TestRunRow[]> {
      const res = await prepare(
        db,
        `SELECT ${RUN_COLUMNS} FROM test_runs WHERE org_id = ?1 AND version_id = ?2 ORDER BY started_at DESC`,
      )
        .bind(orgId, versionId)
        .all<TestRunDbRow>();
      return res.results.map(mapRun);
    },

    async createRun(input: CreateTestRunInput): Promise<TestRunRow> {
      await prepareInsert(
        db,
        `INSERT INTO test_runs (id, org_id, version_id, started_at, results, passed)
         VALUES (?2, ?1, ?3, ?4, ?5, ?6)`,
      )
        .bind(
          orgId,
          input.id,
          input.versionId,
          input.startedAt,
          JSON.stringify(input.results),
          input.passed ? 1 : 0,
        )
        .run();

      return {
        id: input.id,
        orgId,
        versionId: input.versionId,
        startedAt: input.startedAt,
        results: [...input.results],
        passed: input.passed,
      };
    },
  };
}
