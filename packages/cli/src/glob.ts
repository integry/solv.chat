/**
 * A small, dependency-free glob matcher for `--include` and `--exclude`.
 *
 * Patterns match the whole path relative to the pushed folder, with `/`
 * between segments on every OS:
 *
 * - `*` matches any characters except `/`
 * - `**` as a whole segment matches any number of segments, including none
 * - `?` matches one character except `/`
 * - `[abc]`, `[a-z]` and `[!abc]` match one character from (or not from) a set
 * - `{a,b}` matches any one of the comma-separated alternatives
 *
 * A leading `./` is ignored. Every other character matches itself.
 */
export function globToRegExp(pattern: string): RegExp {
  const source = pattern.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
  return new RegExp(`^${translate(source)}$`);
}

function escapeChar(ch: string): string {
  return /[.*+?^${}()|[\]\\/]/.test(ch) ? `\\${ch}` : ch;
}

/** Splits `{a,b{c,d}}` alternatives at top-level commas; null when unbalanced. */
function readBraces(source: string, start: number): { parts: string[]; end: number } | null {
  let depth = 0;
  let current = "";
  const parts: string[] = [];
  for (let i = start; i < source.length; i++) {
    const ch = source[i] as string;
    if (ch === "{") {
      depth++;
      if (depth === 1) continue;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        parts.push(current);
        return { parts, end: i };
      }
    } else if (ch === "," && depth === 1) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  return null;
}

function translate(source: string): string {
  let out = "";
  for (let i = 0; i < source.length; i++) {
    const ch = source[i] as string;
    if (ch === "*") {
      const atSegmentStart = i === 0 || source[i - 1] === "/";
      if (source[i + 1] === "*" && atSegmentStart) {
        const next = source[i + 2];
        if (next === "/") {
          // `**/` matches zero or more whole segments.
          out += "(?:[^/]*/)*";
          i += 2;
          continue;
        }
        if (next === undefined) {
          // A trailing `**` matches everything below.
          out += ".*";
          i += 1;
          continue;
        }
      }
      // Any other run of stars is a single-segment wildcard.
      while (source[i + 1] === "*") i++;
      out += "[^/]*";
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      continue;
    }
    if (ch === "[") {
      const close = source.indexOf("]", i + 2);
      if (close !== -1) {
        let body = source.slice(i + 1, close);
        const negate = body.startsWith("!") || body.startsWith("^");
        if (negate) body = body.slice(1);
        const escaped = body.replace(/[\\\]^]/g, "\\$&");
        out += negate ? `[^/${escaped}]` : `[${escaped}]`;
        i = close;
        continue;
      }
    }
    if (ch === "{") {
      const braces = readBraces(source, i);
      if (braces !== null) {
        out += `(?:${braces.parts.map(translate).join("|")})`;
        i = braces.end;
        continue;
      }
    }
    out += escapeChar(ch);
  }
  return out;
}

/**
 * Keeps the relative paths selected by `include` (all when empty) and not
 * matched by any `exclude` pattern.
 */
export function selectPaths(
  paths: readonly string[],
  include: readonly string[],
  exclude: readonly string[],
): string[] {
  const includes = include.map(globToRegExp);
  const excludes = exclude.map(globToRegExp);
  return paths.filter(
    (path) =>
      (includes.length === 0 || includes.some((re) => re.test(path))) &&
      !excludes.some((re) => re.test(path)),
  );
}
