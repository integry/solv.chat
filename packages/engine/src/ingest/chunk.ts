// Chosen numbers, not specified ones: the architecture document says to chunk
// by heading and says nothing about size. ~1200 characters is about 300 tokens,
// which keeps a handful of chunks inside a modest prompt budget, and the
// overlap keeps a sentence that straddles a split retrievable from either side.
export const MAX_CHARS = 1200;
export const OVERLAP_CHARS = 150;

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

function splitFenceBlock(text: string): string[] {
  if (text.length <= MAX_CHARS) return [text];

  const lines = text.split("\n");
  const openLine = lines[0] ?? "```";
  const fence = parseFenceOpen(openLine);
  const lastLine = lines[lines.length - 1] ?? "";
  const hasClose = lines.length > 1 && fence !== null && isFenceClose(lastLine, fence);
  const closeLine = hasClose ? lastLine : fence !== null ? fence.char.repeat(fence.length) : "```";
  const bodyLines = hasClose ? lines.slice(1, -1) : lines.slice(1);

  if (bodyLines.length === 0) {
    return [text];
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
      const text = (heading[2] ?? "").trim();
      while (stack.length > 0 && (stack[stack.length - 1]?.depth ?? 0) >= depth) {
        stack.pop();
      }
      stack.push({ depth, text });
      continue;
    }

    buffer.push(line);
  }

  flush();
  return chunks;
}
