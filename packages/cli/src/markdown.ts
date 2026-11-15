import { readdir } from "node:fs/promises";
import { join, posix } from "node:path";

export interface FrontMatter {
  title?: string;
}

const MARKDOWN_EXT_RE = /\.(md|markdown)$/i;
const IGNORED_DIRS = new Set([".git", "node_modules"]);

/**
 * Recursively collects `.md` and `.markdown` file paths under `dir`, sorted
 * lexicographically so batches are deterministic across runs.
 */
export async function markdownFiles(dir: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) {
          await walk(join(current, entry.name));
        }
        continue;
      }
      if (entry.isFile() && MARKDOWN_EXT_RE.test(entry.name)) {
        results.push(join(current, entry.name));
      }
    }
  }

  await walk(dir);
  return results;
}

/**
 * Derives a stable, OS-independent `externalId` from the path relative to the
 * content root without its Markdown extension.
 */
export function externalIdFor(root: string, file: string): string {
  const normalizedRoot = root.replace(/\\/g, "/");
  const normalizedFile = file.replace(/\\/g, "/");
  return posix
    .relative(normalizedRoot, normalizedFile)
    .replace(MARKDOWN_EXT_RE, "")
    .split("/")
    .filter((segment) => segment.length > 0)
    .join("/");
}

// YAML 1.2 core-schema scalars that are not strings: `title: 2024` or
// `title: true` is not a title, exactly as a full YAML parser would decide.
const NON_STRING_PLAIN_RE =
  /^(?:~|null|Null|NULL|true|True|TRUE|false|False|FALSE|[-+]?(?:\d+|\d*\.\d+|\d+\.\d*)(?:[eE][-+]?\d+)?|0x[0-9a-fA-F]+|0o[0-7]+|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/;

const DOUBLE_QUOTE_ESCAPES: Record<string, string> = {
  "0": "\0",
  a: "\x07",
  b: "\b",
  t: "\t",
  "\t": "\t",
  n: "\n",
  v: "\v",
  f: "\f",
  r: "\r",
  e: "\x1b",
  " ": " ",
  '"': '"',
  "/": "/",
  "\\": "\\",
  N: "\u0085",
  _: "\u00a0",
  L: "\u2028",
  P: "\u2029",
};

/** Folds the lines of a multi-line flow scalar the way YAML does. */
function foldFlowLines(lines: string[], escapedBreaks = false): string {
  let out = "";
  let pendingBreaks = 0;
  let joinTight = false;
  for (const [index, raw] of lines.entries()) {
    let line = index === 0 ? raw.replace(/\s+$/, "") : raw.trim();
    if (index > 0 && line === "") {
      pendingBreaks++;
      continue;
    }
    if (index > 0) out += joinTight ? "" : pendingBreaks > 0 ? "\n".repeat(pendingBreaks) : " ";
    pendingBreaks = 0;
    // In a double-quoted scalar, a backslash before the line break escapes
    // it: the lines join with nothing between them.
    joinTight = escapedBreaks && /(?:^|[^\\])(?:\\\\)*\\$/.test(line);
    if (joinTight) line = line.slice(0, -1);
    out += line;
  }
  return out;
}

function readDoubleQuoted(text: string): string | undefined {
  let out = "";
  for (let i = 1; i < text.length; i++) {
    const ch = text[i] as string;
    if (ch === '"') return out;
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = text[++i];
    if (next === undefined) return undefined;
    const hexLength = next === "x" ? 2 : next === "u" ? 4 : next === "U" ? 8 : 0;
    if (hexLength > 0) {
      const hex = text.slice(i + 1, i + 1 + hexLength);
      if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== hexLength) return undefined;
      out += String.fromCodePoint(Number.parseInt(hex, 16));
      i += hexLength;
      continue;
    }
    const mapped = DOUBLE_QUOTE_ESCAPES[next];
    if (mapped === undefined) return undefined;
    out += mapped;
  }
  return undefined;
}

function readSingleQuoted(text: string): string | undefined {
  let out = "";
  for (let i = 1; i < text.length; i++) {
    const ch = text[i] as string;
    if (ch !== "'") {
      out += ch;
      continue;
    }
    if (text[i + 1] === "'") {
      out += "'";
      i++;
      continue;
    }
    return out;
  }
  return undefined;
}

/** Reads a `|` or `>` block scalar from its (indented) content lines. */
function readBlockScalar(header: string, lines: string[]): string | undefined {
  const match = /^([|>])([-+]?)(\d?)([-+]?)\s*(?:#.*)?$/.exec(header);
  if (!match) return undefined;
  const folded = match[1] === ">";
  const chomp = match[2] || match[4];
  const nonEmpty = lines.filter((line) => line.trim() !== "");
  const explicit = match[3] ? Number(match[3]) : 0;
  const indent =
    explicit > 0
      ? explicit
      : nonEmpty.length === 0
        ? 0
        : Math.min(...nonEmpty.map((line) => line.length - line.trimStart().length));
  const content = lines.map((line) => line.slice(indent));
  let text = "";
  let started = false;
  let blankLines = 0;
  let previous = "";
  for (const line of content) {
    if (line.trim() === "") {
      blankLines++;
      continue;
    }
    if (!started) {
      text = "\n".repeat(blankLines) + line;
    } else if (folded && !/^\s/.test(line) && !/^\s/.test(previous)) {
      // Folding: one break between lines becomes a space; with blank lines
      // between, the break is dropped and each blank line is a newline.
      text += blankLines > 0 ? `${"\n".repeat(blankLines)}${line}` : ` ${line}`;
    } else {
      text += `${"\n".repeat(blankLines + 1)}${line}`;
    }
    started = true;
    blankLines = 0;
    previous = line;
  }
  if (chomp === "-") return text.replace(/\n+$/, "");
  if (chomp === "+") return `${text}\n`;
  return `${text.replace(/\n+$/, "")}\n`;
}

/**
 * Reads the top-level `title:` scalar of a YAML front matter block.
 *
 * The CLI promises no runtime dependencies, and `title` is the only key it
 * uses, so this reads that one key instead of shipping a YAML parser: plain,
 * single- and double-quoted (one or more lines) and `|`/`>` block scalars.
 * Anything it cannot read as a string yields `undefined`, so the caller falls
 * back to the first heading.
 */
export function readFrontMatterTitle(block: string): string | undefined {
  const lines = block.split(/\r?\n/);
  const start = lines.findIndex((line) => /^title[ \t]*:(?:[ \t]|$)/.test(line));
  if (start === -1) return undefined;
  if (lines.slice(start + 1).some((line) => /^title[ \t]*:(?:[ \t]|$)/.test(line))) {
    // A duplicate key is an error in YAML; do not guess which one was meant.
    return undefined;
  }

  const first = (lines[start] as string).replace(/^title[ \t]*:/, "").trim();
  // Continuation lines belong to the value while they are indented or blank.
  const rest: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== "" && !/^[ \t]/.test(line)) break;
    rest.push(line);
  }
  while (rest.length > 0 && (rest[rest.length - 1] as string).trim() === "") rest.pop();

  if (first.startsWith("|") || first.startsWith(">")) {
    return readBlockScalar(first, rest);
  }
  if (first.startsWith('"') || first.startsWith("'")) {
    const joined = foldFlowLines([first, ...rest], first.startsWith('"'));
    return first.startsWith('"') ? readDoubleQuoted(joined) : readSingleQuoted(joined);
  }
  if (first === "" && rest.length === 0) return undefined;
  if (/^[[{&*!%@`]/.test(first)) return undefined;

  // A plain scalar ends at a ` #` comment, on any of its lines.
  const stripComment = (line: string) => line.replace(/(?:^|[ \t])#.*$/, "");
  const plainLines: string[] = [];
  for (const [index, line] of [first, ...rest].entries()) {
    const stripped = stripComment(line);
    if (index > 0 && stripped.trim() === "" && line.trim().startsWith("#")) break;
    plainLines.push(stripped);
  }
  const value = foldFlowLines(plainLines).trim();
  if (value === "" || NON_STRING_PLAIN_RE.test(value)) return undefined;
  // `title: Hello: world` is not valid YAML; a parser would reject the block.
  if (/:(?:\s|$)/.test(value)) return undefined;
  // A nested mapping (`title:` then `  en: ...`) is not a string either.
  if (first === "" && /^[^\s#][^:]*:(?:\s|$)/.test(rest[0]?.trim() ?? "")) return undefined;
  return value;
}

/**
 * Splits optional YAML front matter (`--- ... ---`) at the start of a Markdown
 * file, extracting `title` when present.
 */
export function splitFrontMatter(raw: string): { frontMatter: FrontMatter; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
  if (!match) {
    return { frontMatter: {}, body: raw };
  }

  const body = raw.slice(match[0].length);
  const frontMatter: FrontMatter = {};
  const title = readFrontMatterTitle(match[1] ?? "")?.trim();
  if (title !== undefined && title.length > 0) {
    frontMatter.title = title;
  }
  return { frontMatter, body };
}

/**
 * Returns the text of the first Markdown ATX heading outside fenced code
 * blocks, or `undefined` when none exists.
 */
export function firstHeading(markdown: string): string | undefined {
  let inFence = false;
  let fenceChar = "";
  let fenceLength = 0;

  for (const line of markdown.split(/\r?\n/)) {
    const trimmed = line.trim();
    const fenceMatch = /^(`{3,}|~{3,})(.*)$/.exec(trimmed);
    if (fenceMatch?.[1]) {
      const delimiter = fenceMatch[1];
      const rest = fenceMatch[2] ?? "";
      const char = delimiter[0] ?? "";
      if (!inFence) {
        inFence = true;
        fenceChar = char;
        fenceLength = delimiter.length;
      } else if (
        char === fenceChar &&
        delimiter.length >= fenceLength &&
        rest.trim().length === 0
      ) {
        inFence = false;
        fenceChar = "";
        fenceLength = 0;
      }
      continue;
    }
    if (inFence) continue;

    const heading = /^#{1,6}\s+(.+?)(?:\s+#+\s*)?$/.exec(trimmed);
    if (heading?.[1]) {
      const text = heading[1].trim();
      if (text.length > 0) return text;
    }
  }

  return undefined;
}
