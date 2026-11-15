const ORG_FILTER_RE = /\borg_id\s*=\s*\?1\b/g;
const INSERT_COLUMNS_RE = /^\s*INSERT\s+(?:OR\s+\w+\s+)?INTO\s+\w+\s*\(([^)]+)\)/i;
const OR_RE = /\bOR\b/gi;
// `INSERT OR IGNORE`, `UPDATE OR REPLACE` and friends are conflict clauses,
// not boolean ORs.
const CONFLICT_OR_RE = /\b(?:INSERT|UPDATE|REPLACE)\s*$/i;

function compactSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

/**
 * Blanks out comments and quoted text, keeping offsets, so neither a comment
 * nor a string literal reading `org_id = ?1` can satisfy the guard.
 */
function codeOnly(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    let end = i;
    if (sql.startsWith("--", i)) {
      const newline = sql.indexOf("\n", i);
      end = newline === -1 ? sql.length : newline;
    } else if (sql.startsWith("/*", i)) {
      const close = sql.indexOf("*/", i + 2);
      end = close === -1 ? sql.length : close + 2;
    } else if (sql[i] === "'" || sql[i] === '"' || sql[i] === "`") {
      const quote = sql[i];
      end = i + 1;
      while (end < sql.length) {
        if (sql[end] === quote) {
          if (sql[end + 1] === quote) {
            end += 2;
            continue;
          }
          end += 1;
          break;
        }
        end += 1;
      }
    } else {
      out += sql[i];
      i += 1;
      continue;
    }
    out += " ".repeat(end - i);
    i = end;
  }
  return out;
}

/**
 * True when some `org_id = ?1` in the statement cannot be bypassed by an OR:
 * none of the parenthesised groups enclosing it, up to the whole statement,
 * has an OR directly at its own level. `org_id = ?1 AND (a OR b)` passes;
 * `org_id = ?1 OR 1 = 1` and `(org_id = ?1 OR 1 = 1)` do not.
 *
 * Limits, stated so nobody leans on more than this: it is not a SQL parser.
 * A filter that appears only inside a subquery passes even though it
 * constrains the subquery's rows, not the statement's.
 */
function hasUnbypassedOrgFilter(sql: string): boolean {
  const code = codeOnly(sql);

  // Group 0 is the whole statement; every "(" opens a child group.
  const parent: number[] = [-1];
  const hasOr: boolean[] = [false];
  const groupAt: number[] = new Array(code.length);
  const stack: number[] = [0];
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === "(") {
      const id = parent.length;
      parent.push(stack[stack.length - 1] ?? 0);
      hasOr.push(false);
      stack.push(id);
      groupAt[i] = id;
    } else if (ch === ")") {
      groupAt[i] = stack[stack.length - 1] ?? 0;
      if (stack.length > 1) stack.pop();
    } else {
      groupAt[i] = stack[stack.length - 1] ?? 0;
    }
  }

  for (const match of code.matchAll(OR_RE)) {
    if (CONFLICT_OR_RE.test(code.slice(0, match.index))) continue;
    hasOr[groupAt[match.index] ?? 0] = true;
  }

  for (const match of code.matchAll(ORG_FILTER_RE)) {
    let group = groupAt[match.index] ?? 0;
    let bypassed = false;
    while (group !== -1) {
      if (hasOr[group]) {
        bypassed = true;
        break;
      }
      group = parent[group] ?? -1;
    }
    if (!bypassed) return true;
  }
  return false;
}

/**
 * Prepares a SELECT, UPDATE, or DELETE statement after verifying it filters on
 * `org_id = ?1` outside comments and quoted text, with no OR able to bypass
 * it. A missing filter throws immediately rather than leaking rows across
 * tenants.
 */
export function prepare(db: D1Database, sql: string): D1PreparedStatement {
  if (!hasUnbypassedOrgFilter(sql)) {
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
