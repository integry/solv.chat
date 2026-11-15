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
  published_anyway: number;
  config_hash: string | null;
}

export interface TestRow {
  id: string;
  orgId: string;
  assistantId: string;
  question: string;
  expectation: Record<string, unknown>;
  createdAt: number;
}

export interface TestWithLatestResult extends TestRow {
  latestResult: unknown | null;
}

export interface TestRunRow {
  id: string;
  orgId: string;
  versionId: string;
  startedAt: number;
  results: unknown[];
  passed: boolean;
  publishedAnyway: boolean;
  configHash: string | null;
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
  configHash?: string | null | undefined;
}

const TEST_COLUMNS = "id, org_id, assistant_id, question, expectation, created_at";
const RUN_COLUMNS =
  "id, org_id, version_id, started_at, results, passed, published_anyway, config_hash";

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
  publishedAnyway: row.published_anyway === 1,
  configHash: row.config_hash ?? null,
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

    async listWithLatestResult(assistantId: string): Promise<TestWithLatestResult[]> {
      const [tests, latest] = await Promise.all([
        this.list(assistantId),
        this.latestRun(assistantId),
      ]);
      const byTestId = new Map<string, unknown>();
      if (latest !== null) {
        for (const entry of latest.results) {
          if (
            typeof entry === "object" &&
            entry !== null &&
            "testId" in entry &&
            typeof (entry as { testId: unknown }).testId === "string"
          ) {
            byTestId.set((entry as { testId: string }).testId, entry);
          }
        }
      }
      return tests.map((test) => ({
        ...test,
        latestResult: byTestId.get(test.id) ?? null,
      }));
    },

    async countFor(assistantId: string): Promise<number> {
      const row = await prepare(
        db,
        "SELECT COUNT(*) AS n FROM tests WHERE org_id = ?1 AND assistant_id = ?2",
      )
        .bind(orgId, assistantId)
        .first<{ n: number }>();
      return row?.n ?? 0;
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

    async createIfUnderLimit(input: CreateTestInput, maxTests: number): Promise<TestRow | null> {
      const res = await prepareInsert(
        db,
        `INSERT INTO tests (id, org_id, assistant_id, question, expectation, created_at)
         SELECT ?2, ?1, ?3, ?4, ?5, ?6
         WHERE (SELECT COUNT(*) FROM tests WHERE org_id = ?1 AND assistant_id = ?3) < ?7`,
      )
        .bind(
          orgId,
          input.id,
          input.assistantId,
          input.question,
          JSON.stringify(input.expectation),
          input.createdAt,
          maxTests,
        )
        .run();

      if ((res.meta.changes ?? 0) === 0) return null;

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

    async updateTest(
      id: string,
      input: { question: string; expectation: Record<string, unknown> },
    ): Promise<boolean> {
      const res = await prepare(
        db,
        "UPDATE tests SET question = ?3, expectation = ?4 WHERE org_id = ?1 AND id = ?2",
      )
        .bind(orgId, id, input.question, JSON.stringify(input.expectation))
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

    async listRunsForAssistant(assistantId: string, limit = 20): Promise<TestRunRow[]> {
      const res = await prepare(
        db,
        `SELECT r.id, r.org_id, r.version_id, r.started_at, r.results, r.passed, r.published_anyway, r.config_hash
         FROM test_runs r
         JOIN assistant_versions v ON v.org_id = r.org_id AND v.id = r.version_id
         WHERE r.org_id = ?1 AND v.assistant_id = ?2
         ORDER BY r.started_at DESC
         LIMIT ?3`,
      )
        .bind(orgId, assistantId, limit)
        .all<TestRunDbRow>();
      return res.results.map(mapRun);
    },

    async getRunForAssistant(assistantId: string, runId: string): Promise<TestRunRow | null> {
      const row = await prepare(
        db,
        `SELECT r.id, r.org_id, r.version_id, r.started_at, r.results, r.passed, r.published_anyway, r.config_hash
         FROM test_runs r
         JOIN assistant_versions v ON v.org_id = r.org_id AND v.id = r.version_id
         WHERE r.org_id = ?1 AND r.id = ?2 AND v.assistant_id = ?3`,
      )
        .bind(orgId, runId, assistantId)
        .first<TestRunDbRow>();
      return row ? mapRun(row) : null;
    },

    async latestRun(assistantId: string): Promise<TestRunRow | null> {
      const rows = await this.listRunsForAssistant(assistantId, 1);
      return rows[0] ?? null;
    },

    async createRun(input: CreateTestRunInput): Promise<TestRunRow> {
      const configHash = input.configHash ?? null;
      await prepareInsert(
        db,
        `INSERT INTO test_runs (id, org_id, version_id, started_at, results, passed, config_hash)
         VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7)`,
      )
        .bind(
          orgId,
          input.id,
          input.versionId,
          input.startedAt,
          JSON.stringify(input.results),
          input.passed ? 1 : 0,
          configHash,
        )
        .run();

      return {
        id: input.id,
        orgId,
        versionId: input.versionId,
        startedAt: input.startedAt,
        results: [...input.results],
        passed: input.passed,
        publishedAnyway: false,
        configHash,
      };
    },

    async markPublishedAnyway(runId: string): Promise<void> {
      await prepare(db, "UPDATE test_runs SET published_anyway = 1 WHERE org_id = ?1 AND id = ?2")
        .bind(orgId, runId)
        .run();
    },
  };
}
