const ORG_FILTER_RE = /\borg_id\s*=\s*\?1\b/;
const INSERT_COLUMNS_RE = /^\s*INSERT\s+(?:OR\s+\w+\s+)?INTO\s+\w+\s*\(([^)]+)\)/i;

function compactSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

/**
 * Prepares a SELECT, UPDATE, or DELETE statement after verifying it filters on
 * `org_id = ?1`. A missing filter throws immediately rather than leaking rows
 * across tenants.
 */
export function prepare(db: D1Database, sql: string): D1PreparedStatement {
  if (!ORG_FILTER_RE.test(sql)) {
    throw new Error(`statement must filter on org_id = ?1: ${compactSql(sql)}`);
  }
  return db.prepare(sql);
}

/**
 * Prepares an INSERT statement after verifying `org_id` is among the target
 * columns.
 */
export function prepareInsert(db: D1Database, sql: string): D1PreparedStatement {
  const match = INSERT_COLUMNS_RE.exec(sql);
  const columns = match?.[1]?.split(",").map((col) => col.trim().toLowerCase()) ?? [];
  if (!columns.includes("org_id")) {
    throw new Error(`insert statement must include org_id column: ${compactSql(sql)}`);
  }
  return db.prepare(sql);
}

/**
 * Parses a JSON column without throwing. One malformed JSON column must not
 * crash a list query and blank a whole screen.
 */
export function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** Parses a JSON array column, falling back to `[]` if malformed or not an array. */
export function safeJsonArray<T = unknown>(raw: string): T[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/** Parses a JSON object column, falling back to `{}` if malformed or not an object. */
export function safeJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}
