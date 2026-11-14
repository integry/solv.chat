import { readdir } from "node:fs/promises";
import { join, posix } from "node:path";
import { parse } from "yaml";

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

/**
 * Splits optional YAML front matter (`--- ... ---`) at the start of a Markdown
 * file, extracting `title` when present.
 */
export function splitFrontMatter(raw: string): { frontMatter: FrontMatter; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
  if (!match) {
    return { frontMatter: {}, body: raw };
  }

  const block = match[1] ?? "";
  const body = raw.slice(match[0].length);
  const frontMatter: FrontMatter = {};

  let parsed: unknown;
  try {
    parsed = parse(block);
  } catch {
    return { frontMatter, body };
  }

  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    const title = (parsed as Record<string, unknown>).title;
    if (typeof title === "string") {
      const trimmed = title.trim();
      if (trimmed.length > 0) {
        frontMatter.title = trimmed;
      }
    }
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
