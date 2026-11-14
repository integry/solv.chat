// Chosen numbers, not specified ones: the architecture document says to chunk
// by heading and says nothing about size. ~1200 characters is about 300 tokens,
// which keeps a handful of chunks inside a modest prompt budget, and the
// overlap keeps a sentence that straddles a split retrievable from either side.
export const MAX_CHARS = 1200;
export const OVERLAP_CHARS = 150;
// A heading longer than this is cut. Six levels of it keep the path (which is
// embedded with the chunk and shown in the prompt) far inside the embedding
// model's input limit, whatever a document's heading lines look like.
export const MAX_HEADING_CHARS = 200;
// Every chunk is one statement in the single D1 batch that commits a
// document, and that batch must stay under 2,000 statements (see
// `replaceChunks`). A normal 1 MiB document yields about 900 chunks; only one
// made of thousands of tiny sections reaches this, and it is packed first.
export const MAX_CHUNKS = 1500;

export interface Chunk {
  ordinal: number;
  text: string;
  headingPath: string[];
}

interface Block {
  text: string;
  isFence: boolean;
}

interface FenceState {
  char: "`" | "~";
  length: number;
}

function parseFenceOpen(line: string): FenceState | null {
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

function isFenceClose(line: string, fence: FenceState): boolean {
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
export function chunkMarkdown(markdown: string): Chunk[] {
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
  return chunks.length > MAX_CHUNKS ? limitChunkCount(chunks) : chunks;
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
 * Brings a document made of many tiny sections under `MAX_CHUNKS` without
 * losing words: neighbouring chunks are packed into one up to `MAX_CHARS`,
 * keeping the headings they share as the path and writing the rest into the
 * text. Deterministic, so the same document always packs the same way. A
 * document still over the cap after packing (only possible with very deep,
 * repeated heading paths) keeps its first `MAX_CHUNKS` chunks; failing the
 * whole document would retry it into the dead-letter queue with nothing
 * indexed at all.
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

  if (packed.length > MAX_CHUNKS) {
    console.warn("chunkMarkdown: document truncated to the chunk cap", {
      chunks: packed.length,
      kept: MAX_CHUNKS,
    });
    return packed.slice(0, MAX_CHUNKS);
  }
  return packed;
}
