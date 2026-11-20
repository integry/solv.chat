// Chosen numbers, not specified ones: the architecture document says to chunk
// by heading and says nothing about size. ~1200 characters is about 300 tokens,
// which keeps a handful of chunks inside a modest prompt budget, and the
// overlap keeps a sentence that straddles a split retrievable from either side.
import { fitsSourceBudget } from "../chat/prompt.js";

export const MAX_CHARS = 1200;
export const OVERLAP_CHARS = 150;
// A heading longer than this is cut. Six levels of it keep the path (which is
// embedded with the chunk and shown in the prompt) far inside the embedding
// model's input limit, whatever a document's heading lines look like.
export const MAX_HEADING_CHARS = 200;
// Every chunk is one statement in the single D1 batch that commits a
// document, and that batch must stay under 2,000 statements (see
// `replaceChunks`). A normal 1 MiB document yields about 900 chunks; only one
// made of thousands of tiny sections reaches this, and it is packed first;
// one still over the cap after packing is refused, never cut.
export const MAX_CHUNKS = 1500;
/**
 * No chunk is stored with less text than this; a shorter one is merged into
 * a neighbour (see `mergeSmallChunks`). Measured from issue #123: the chunks
 * that crowded out real answers were footer and "related" lists of 45 to 74
 * characters, embedded behind a heading path of 40 to 60 characters
 * ("How to test an MCP server before you deploy it > Guides"). At that size
 * the path is most of the embedding input, so `text-embedding-3-small`
 * scores the chunk on its page's title, not its words; OpenAI's guide says
 * nothing about a minimum length, so the number is ours. 200 characters is
 * about 50 tokens, two or three sentences: over three times the heading paths
 * above and the longest chrome chunk, and a sixth of `MAX_CHARS`, so a merge
 * never makes a chunk much larger than a full one. A document whose whole
 * text is shorter (a one-line written answer) is still one chunk, and so is
 * a short section no neighbour can take without the prompt cutting the
 * result (long, divergent heading paths; see `mergeSmallChunks`).
 */
export const MIN_CHUNK_CHARS = 200;

export interface Chunk {
  ordinal: number;
  text: string;
  headingPath: string[];
}

interface Block {
  text: string;
  isFence: boolean;
}

export interface FenceState {
  char: "`" | "~";
  length: number;
}

export function parseFenceOpen(line: string): FenceState | null {
  const match = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
  if (match === null) return null;
  const marker = match[1];
  const rest = match[2] ?? "";
  if (!marker) return null;
  const char = marker[0] as "`" | "~";
  // CommonMark: backtick info strings cannot contain backticks.
  if (char === "`" && rest.includes("`")) return null;
  return { char, length: marker.length };
}

export function isFenceClose(line: string, fence: FenceState): boolean {
  const match = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
  if (match === null) return false;
  const marker = match[1];
  if (!marker) return false;
  return marker[0] === fence.char && marker.length >= fence.length;
}

/**
 * Splits a section's lines into paragraph/fence blocks so blank lines inside a
 * fenced code block never split the fence in half.
 */
function toBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let current: string[] = [];
  let fence: FenceState | null = null;
  let currentIsFence = false;

  const flushBlock = () => {
    const text = current.join("\n").trim();
    current = [];
    if (text !== "") {
      blocks.push({ text, isFence: currentIsFence });
    }
    currentIsFence = false;
  };

  for (const line of lines) {
    if (fence !== null) {
      current.push(line);
      if (isFenceClose(line, fence)) {
        fence = null;
        flushBlock();
      }
      continue;
    }

    const opened = parseFenceOpen(line);
    if (opened !== null) {
      flushBlock();
      fence = opened;
      currentIsFence = true;
      current.push(line);
      continue;
    }

    if (line.trim() === "") {
      flushBlock();
      continue;
    }

    current.push(line);
  }

  flushBlock();
  return blocks;
}

function splitProseBlock(text: string, maxLen = MAX_CHARS - OVERLAP_CHARS - 2): string[] {
  if (text.length <= MAX_CHARS) return [text];

  const pieces: string[] = [];
  let start = 0;

  while (start < text.length) {
    while (start < text.length && /\s/.test(text[start] ?? "")) {
      start++;
    }
    if (start >= text.length) break;

    if (text.length - start <= maxLen) {
      pieces.push(text.slice(start).trim());
      break;
    }

    const window = text.slice(start, start + maxLen + 1);
    let splitAt = -1;
    for (let i = window.length - 1; i > 0; i--) {
      if (/\s/.test(window[i] ?? "")) {
        splitAt = i;
        break;
      }
    }

    if (splitAt <= 0) {
      // No whitespace in the window (e.g., a single long token): hard split.
      pieces.push(text.slice(start, start + maxLen));
      start += maxLen;
    } else {
      const piece = text.slice(start, start + splitAt).trim();
      if (piece !== "") {
        pieces.push(piece);
      }
      start += splitAt + 1;
    }
  }

  return pieces;
}

const MAX_FENCE_MARKER_LEN = 32;
const MAX_FENCE_INFO_LEN = 64;

function splitFenceBlock(text: string): string[] {
  if (text.length <= MAX_CHARS) return [text];

  const lines = text.split("\n");
  const rawOpenLine = lines[0] ?? "```";
  const fenceMatch = /^\s*(`{3,}|~{3,})(.*)$/.exec(rawOpenLine);
  const fence = parseFenceOpen(rawOpenLine);
  const lastLine = lines[lines.length - 1] ?? "";
  const hasClose = lines.length > 1 && fence !== null && isFenceClose(lastLine, fence);

  const marker =
    fence !== null ? fence.char.repeat(Math.min(fence.length, MAX_FENCE_MARKER_LEN)) : "```";
  const rawInfo = fence !== null && fenceMatch !== null ? (fenceMatch[2] ?? "").trimEnd() : "";
  const maxInfoLen = Math.max(0, Math.min(MAX_FENCE_INFO_LEN, MAX_CHARS - marker.length * 2 - 3));
  const openLine = `${marker}${rawInfo.slice(0, maxInfoLen)}`;
  const closeLine = marker;

  const bodyLines = hasClose ? lines.slice(1, -1) : lines.slice(1);
  if (bodyLines.length === 0) {
    return [`${openLine}\n${closeLine}`];
  }

  const maxBodyChars = Math.max(1, MAX_CHARS - openLine.length - closeLine.length - 2);
  const chunks: string[] = [];
  let currentLines: string[] = [];
  let currentLen = 0;

  const flushFence = () => {
    if (currentLines.length === 0) return;
    chunks.push(`${openLine}\n${currentLines.join("\n")}\n${closeLine}`);
    currentLines = [];
    currentLen = 0;
  };

  for (const line of bodyLines) {
    if (line.length > maxBodyChars) {
      flushFence();
      for (let i = 0; i < line.length; i += maxBodyChars) {
        chunks.push(`${openLine}\n${line.slice(i, i + maxBodyChars)}\n${closeLine}`);
      }
      continue;
    }

    const addedLen = currentLines.length === 0 ? line.length : 1 + line.length;
    if (currentLines.length > 0 && currentLen + addedLen > maxBodyChars) {
      flushFence();
    }
    currentLines.push(line);
    currentLen += currentLines.length === 1 ? line.length : 1 + line.length;
  }

  flushFence();
  return chunks;
}

function expandOversizedBlocks(blocks: Block[]): Block[] {
  const expanded: Block[] = [];
  for (const block of blocks) {
    if (block.text.length <= MAX_CHARS) {
      expanded.push(block);
      continue;
    }
    const parts = block.isFence ? splitFenceBlock(block.text) : splitProseBlock(block.text);
    for (const part of parts) {
      expanded.push({ text: part, isFence: block.isFence });
    }
  }
  return expanded;
}

function splitLong(lines: string[]): string[] {
  const rawBlocks = toBlocks(lines);
  if (rawBlocks.length === 0) return [];

  const blocks = expandOversizedBlocks(rawBlocks);
  const fullText = blocks.map((b) => b.text).join("\n\n");
  if (fullText.length <= MAX_CHARS) return [fullText];

  const pieces: string[] = [];
  let current = "";
  let lastBlock: Block | null = null;

  for (const block of blocks) {
    if (current !== "" && current.length + 2 + block.text.length > MAX_CHARS) {
      pieces.push(current);
      // Carry the tail of the last prose block forward so a question whose
      // answer spans the boundary still matches one chunk well. Never slice
      // into a fenced code block, which would leave an unclosed fence.
      const overlap =
        lastBlock !== null && !lastBlock.isFence ? lastBlock.text.slice(-OVERLAP_CHARS).trim() : "";
      current = overlap !== "" ? `${overlap}\n\n${block.text}` : block.text;
    } else {
      current = current === "" ? block.text : `${current}\n\n${block.text}`;
    }
    lastBlock = block;
  }

  if (current.trim() !== "") {
    pieces.push(current);
  }

  return pieces;
}

/**
 * Splits Markdown by ATX headings, carrying the heading path on each chunk and
 * subdividing long sections at paragraph boundaries with overlap.
 */
export function chunkMarkdown(
  markdown: string,
  options: { minChars?: number | undefined } = {},
): Chunk[] {
  const chunks: Chunk[] = [];
  const stack: Array<{ depth: number; text: string }> = [];
  let buffer: string[] = [];
  let fence: FenceState | null = null;

  const flush = () => {
    const lines = buffer;
    buffer = [];
    const headingPath = stack.map((entry) => entry.text);
    for (const piece of splitLong(lines)) {
      chunks.push({
        ordinal: chunks.length,
        text: piece,
        headingPath,
      });
    }
  };

  for (const line of markdown.split(/\r?\n/)) {
    if (fence !== null) {
      buffer.push(line);
      if (isFenceClose(line, fence)) {
        fence = null;
      }
      continue;
    }

    const opened = parseFenceOpen(line);
    if (opened !== null) {
      fence = opened;
      buffer.push(line);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading !== null) {
      flush();
      const depth = heading[1]?.length ?? 1;
      const text = (heading[2] ?? "").trim().slice(0, MAX_HEADING_CHARS).trimEnd();
      while (stack.length > 0 && (stack[stack.length - 1]?.depth ?? 0) >= depth) {
        stack.pop();
      }
      stack.push({ depth, text });
      continue;
    }

    buffer.push(line);
  }

  flush();
  const merged = mergeSmallChunks(chunks, options.minChars ?? MIN_CHUNK_CHARS);
  return merged.length > MAX_CHUNKS ? limitChunkCount(merged) : merged;
}

function commonPrefix(a: string[], b: string[]): string[] {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return a.slice(0, n);
}

/** A member's text under `base`: its own deeper headings become heading lines. */
function renderUnder(base: string[], chunk: Chunk): string {
  const lines = chunk.headingPath
    .slice(base.length)
    .map((heading, i) => `${"#".repeat(Math.min(6, base.length + i + 1))} ${heading}`);
  return [...lines, chunk.text].join("\n\n");
}

/**
 * The heading path a merged chunk's text ends under, when it differs from
 * its `headingPath` (the headings its parts share). Kept beside the chunk,
 * not in it, so the stored shape does not change.
 */
const endsUnder = new WeakMap<Chunk, string[]>();

/**
 * Two neighbouring chunks as one, keeping the headings they share as the
 * path and writing the rest into the text. The second part repeats none of
 * the heading lines the first part already ends under.
 */
function mergePair(first: Chunk, second: Chunk): Chunk {
  const base = commonPrefix(first.headingPath, second.headingPath);
  const firstEnd = endsUnder.get(first) ?? first.headingPath;
  const open = Math.max(base.length, commonPrefix(firstEnd, second.headingPath).length);
  const secondLines = second.headingPath
    .slice(open)
    .map((heading, i) => `${"#".repeat(Math.min(6, open + i + 1))} ${heading}`);
  const merged: Chunk = {
    ordinal: first.ordinal,
    headingPath: base,
    text: [renderUnder(base, first), ...secondLines, second.text].join("\n\n"),
  };
  endsUnder.set(merged, endsUnder.get(second) ?? second.headingPath);
  return merged;
}

const samePath = (a: Chunk, b: Chunk): boolean =>
  a.headingPath.length === b.headingPath.length &&
  a.headingPath.every((heading, i) => heading === b.headingPath[i]);

/**
 * A heading path as it is stored and shown to the model (see `chunksToIndex`
 * in `ingest/consumer.ts`).
 */
export function joinHeadingPath(headingPath: readonly string[]): string {
  return headingPath.join(" > ");
}

/**
 * Merges every chunk shorter than `minChars` into a neighbour, so no chunk
 * is stored on a few words. For each short chunk, the neighbour is, in
 * order: one under the same heading path (the previous, then the next)
 * that the two fit together within `MAX_CHARS`; the previous one, then the
 * next, within `MAX_CHARS`; and when neither fits, the same-heading one,
 * else the previous, else the next, larger than `MAX_CHARS` (at most about
 * `MAX_CHARS + minChars` and the headings). Every merge must also reach the
 * model whole: its `section:` line and text within the prompt's per-source
 * allowance (`fitsSourceBudget`), since the prompt cuts what is over it and
 * the cut part would exist in no other chunk. A short chunk no neighbour
 * can take on those terms is kept as it is. A merge keeps the shared
 * headings as the path and writes the rest into the text, so no word or
 * heading is lost. A document with one chunk keeps it, however short.
 */
export function mergeSmallChunks(chunks: readonly Chunk[], minChars: number): Chunk[] {
  const out = [...chunks];
  const small = (chunk: Chunk) => chunk.text.length < minChars;
  const whole = (merged: Chunk | undefined): merged is Chunk =>
    merged !== undefined && fitsSourceBudget(joinHeadingPath(merged.headingPath), merged.text);
  const full = (merged: Chunk | undefined): merged is Chunk =>
    whole(merged) && merged.text.length <= MAX_CHARS;
  let i = 0;
  while (out.length > 1 && i < out.length) {
    const chunk = out[i] as Chunk;
    if (!small(chunk)) {
      i++;
      continue;
    }
    const prev = i > 0 ? (out[i - 1] as Chunk) : undefined;
    const next = i + 1 < out.length ? (out[i + 1] as Chunk) : undefined;
    const withPrev = prev === undefined ? undefined : mergePair(prev, chunk);
    const withNext = next === undefined ? undefined : mergePair(chunk, next);
    const prevSame = prev !== undefined && samePath(prev, chunk);
    const nextSame = next !== undefined && samePath(next, chunk);
    const candidates: Array<[side: "prev" | "next", merged: Chunk | undefined, ok: boolean]> = [
      ["prev", withPrev, prevSame && full(withPrev)],
      ["next", withNext, nextSame && full(withNext)],
      ["prev", withPrev, full(withPrev)],
      ["next", withNext, full(withNext)],
      ["prev", withPrev, prevSame && whole(withPrev)],
      ["next", withNext, nextSame && whole(withNext)],
      ["prev", withPrev, whole(withPrev)],
      ["next", withNext, whole(withNext)],
    ];
    const found = candidates.find(([, , ok]) => ok);
    if (found === undefined) {
      // Any merge would be cut in the prompt: keep the short chunk whole.
      i++;
      continue;
    }
    const [side, merged] = found as ["prev" | "next", Chunk, boolean];
    if (side === "prev") {
      out.splice(i - 1, 2, merged);
      // The merged chunk is not short; carry on with what follows it.
    } else {
      out.splice(i, 2, merged);
      // The merged chunk may still be short (two short ones); look again.
    }
  }
  return out.map((chunk, ordinal) => ({ ...chunk, ordinal }));
}

/**
 * Brings a document made of many tiny sections under `MAX_CHUNKS` without
 * losing words: neighbouring chunks are packed into one up to `MAX_CHARS`,
 * keeping the headings they share as the path and writing the rest into the
 * text. Deterministic, so the same document always packs the same way. A
 * document still over the cap after packing (only possible with very deep,
 * repeated heading paths) is returned whole, never cut: `pushDocuments`
 * refuses it with a message naming the document, and the consumer will not
 * mark it indexed (see `exceedsChunkBudget`).
 */
function limitChunkCount(chunks: Chunk[]): Chunk[] {
  const groups: Chunk[][] = [];
  let current: Chunk[] = [];
  let size = 0;
  for (const chunk of chunks) {
    // Measured against an empty base: an upper bound on the rendered size,
    // since a shared path only removes heading lines.
    const own = renderUnder([], chunk).length;
    if (current.length > 0 && size + 2 + own > MAX_CHARS) {
      groups.push(current);
      current = [];
      size = 0;
    }
    current.push(chunk);
    size += (size === 0 ? 0 : 2) + own;
  }
  if (current.length > 0) groups.push(current);

  const packed = groups.map((group, ordinal): Chunk => {
    const [first] = group;
    if (group.length === 1 && first !== undefined) return { ...first, ordinal };
    const base = group.reduce(
      (prefix, chunk) => commonPrefix(prefix, chunk.headingPath),
      first?.headingPath ?? [],
    );
    return {
      ordinal,
      headingPath: base,
      text: group.map((chunk) => renderUnder(base, chunk)).join("\n\n"),
    };
  });

  return packed;
}

/**
 * True when a document's chunks cannot be committed in one D1 batch. Such a
 * document is rejected rather than indexed in part: a partial index stored
 * under the document's full content hash would look complete, and the
 * missing sections could never be found or re-indexed.
 */
export function exceedsChunkBudget(chunks: readonly Chunk[]): boolean {
  return chunks.length > MAX_CHUNKS;
}
