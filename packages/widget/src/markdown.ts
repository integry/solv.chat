/**
 * Parses a URL string and returns it only if its scheme is `http:` or `https:`.
 * Used for both citation chips and Markdown links so `javascript:`, `data:`,
 * and other non-HTTP schemes never become clickable links.
 */
export function parseSafeHttpUrl(raw: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return null;
  }
  return parsed;
}

type ListKind = "ul" | "ol";

interface ListItem {
  text: string;
  nested?: ListData[] | undefined;
}

interface ListData {
  kind: ListKind;
  start?: number | undefined;
  items: ListItem[];
}

type ParsedBlock =
  | { type: "paragraph"; source: string; text: string; literal?: boolean }
  | { type: "code"; source: string; code: string }
  | { type: "list"; source: string; list: ListData };

interface ListMatch {
  indent: number;
  kind: ListKind;
  start?: number | undefined;
  text: string;
}

const FENCE_OPEN_RE = /^ {0,3}(`{3,})(.*)$/;
const UNORDERED_RE = /^([ \t]*)[-*+] (.*)$/;
const ORDERED_RE = /^([ \t]*)(\d+)\. (.*)$/;
const ATX_HEADING_RE = /^ {0,3}#{1,6}(?:[ \t]|$)/;
const SETEXT_UNDERLINE_RE = /^ {0,3}(?:={2,}|-{2,})[ \t]*$/;
const THEMATIC_BREAK_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const BLOCK_QUOTE_RE = /^ {0,3}>/;
const TABLE_DELIMITER_CELL_RE = /^[ \t]*:?-+:?[ \t]*$/;

function measureIndent(prefix: string): number {
  let count = 0;
  for (const ch of prefix) {
    count += ch === "\t" ? 2 : 1;
  }
  return count;
}

function leadingIndent(line: string): number {
  const m = /^([ \t]*)/.exec(line);
  return measureIndent(m?.[1] ?? "");
}

function isAtxHeading(line: string): boolean {
  return ATX_HEADING_RE.test(line);
}

function isBlockQuoteLine(line: string): boolean {
  return BLOCK_QUOTE_RE.test(line);
}

function isThematicBreak(line: string): boolean {
  return THEMATIC_BREAK_RE.test(line);
}

function isEscaped(str: string, index: number): boolean {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && str[i] === "\\"; i--) {
    backslashes++;
  }
  return backslashes % 2 === 1;
}

function splitTableRow(line: string): string[] | null {
  if (leadingIndent(line) > 3) return null;
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return null;
  let content = trimmed;
  if (content.startsWith("|")) {
    content = content.slice(1);
  }
  if (content.endsWith("|") && !isEscaped(content, content.length - 1)) {
    content = content.slice(0, -1);
  }
  const cells: string[] = [];
  let start = 0;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\\" && i + 1 < content.length) {
      i++;
      continue;
    }
    if (content[i] === "|") {
      cells.push(content.slice(start, i));
      start = i + 1;
    }
  }
  cells.push(content.slice(start));
  return cells;
}

function isTableStart(lines: string[], index: number): boolean {
  if (index + 1 >= lines.length) return false;
  const headerLine = lines[index] ?? "";
  const delimLine = lines[index + 1] ?? "";
  if (
    matchFenceOpen(headerLine) !== null ||
    isAtxHeading(headerLine) ||
    isBlockQuoteLine(headerLine) ||
    isThematicBreak(headerLine)
  ) {
    return false;
  }
  const headerList = matchListLine(headerLine);
  if (headerList && headerList.indent <= 3) {
    return false;
  }
  const delimList = matchListLine(delimLine);
  if (delimList && delimList.indent <= 3) {
    return false;
  }
  const headerCells = splitTableRow(headerLine);
  const delimCells = splitTableRow(delimLine);
  if (!headerCells || !delimCells || headerCells.length !== delimCells.length) {
    return false;
  }
  return delimCells.every((cell) => TABLE_DELIMITER_CELL_RE.test(cell));
}

function isBlockBoundaryLine(lines: string[], index: number, checkTable = true): boolean {
  const line = lines[index] ?? "";
  if (line.trim() === "") return true;
  if (matchFenceOpen(line) !== null) return true;
  const list = matchListLine(line);
  if (list && list.indent <= 3) return true;
  if (isAtxHeading(line) || isBlockQuoteLine(line) || isThematicBreak(line)) return true;
  if (checkTable && isTableStart(lines, index)) return true;
  return false;
}

function collectBlockQuote(lines: string[], startIndex: number): number {
  let i = startIndex;
  let innerFenceLen: number | null = null;

  const updateInnerFence = (rawLine: string): { canLazyContinue: boolean } => {
    const inner = rawLine.replace(/^(?: {0,3}>[ \t]?)+/, "");
    if (innerFenceLen !== null) {
      const closeMatch = /^ {0,3}(`{3,})\s*$/.exec(inner);
      if (closeMatch && (closeMatch[1]?.length ?? 0) >= innerFenceLen) {
        innerFenceLen = null;
      }
      return { canLazyContinue: false };
    }
    const openLen = matchFenceOpen(inner);
    if (openLen !== null) {
      innerFenceLen = openLen;
      return { canLazyContinue: false };
    }
    if (inner.trim() === "" || isAtxHeading(inner) || isThematicBreak(inner)) {
      return { canLazyContinue: false };
    }
    return { canLazyContinue: true };
  };

  let state = updateInnerFence(lines[i] ?? "");
  i++;

  while (i < lines.length) {
    const nextLine = lines[i] ?? "";
    if (nextLine.trim() === "") {
      break;
    }
    if (isBlockQuoteLine(nextLine)) {
      state = updateInnerFence(nextLine);
      i++;
      continue;
    }
    if (!state.canLazyContinue) {
      break;
    }
    if (isBlockBoundaryLine(lines, i) || SETEXT_UNDERLINE_RE.test(nextLine)) {
      break;
    }
    i++;
  }

  return i;
}

function collectTable(lines: string[], startIndex: number): number {
  let i = startIndex + 2;
  while (i < lines.length) {
    const nextLine = lines[i] ?? "";
    if (nextLine.trim() === "" || leadingIndent(nextLine) > 3 || !nextLine.includes("|")) {
      break;
    }
    if (isBlockBoundaryLine(lines, i, false)) {
      break;
    }
    i++;
  }
  return i;
}

function matchListLine(line: string): ListMatch | null {
  const ul = UNORDERED_RE.exec(line);
  if (ul) {
    return {
      indent: measureIndent(ul[1] ?? ""),
      kind: "ul",
      text: ul[2] ?? "",
    };
  }
  const ol = ORDERED_RE.exec(line);
  if (ol) {
    return {
      indent: measureIndent(ol[1] ?? ""),
      kind: "ol",
      start: Number(ol[2]),
      text: ol[3] ?? "",
    };
  }
  return null;
}

function findClosingFence(lines: string[], startIndex: number, minLength: number): number {
  for (let j = startIndex; j < lines.length; j++) {
    const line = lines[j] ?? "";
    const match = /^ {0,3}(`{3,})\s*$/.exec(line);
    if (match && (match[1]?.length ?? 0) >= minLength) {
      return j;
    }
  }
  return -1;
}

function matchFenceOpen(line: string): number | null {
  const open = FENCE_OPEN_RE.exec(line);
  if (!open || (open[2] ?? "").includes("`")) return null;
  return open[1]?.length ?? 3;
}

function parseBlocks(markdown: string): ParsedBlock[] {
  const normalized = markdown.replace(/\r\n?/g, "\n");
  if (!normalized) return [];

  const lines = normalized.split("\n");
  const lineStarts: number[] = new Array<number>(lines.length);
  let offset = 0;
  for (let k = 0; k < lines.length; k++) {
    lineStarts[k] = offset;
    offset += (lines[k]?.length ?? 0) + 1;
  }

  const blocks: ParsedBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    if (line.trim() === "") {
      i++;
      continue;
    }

    const fenceLen = matchFenceOpen(line);
    if (fenceLen !== null) {
      const closeIndex = findClosingFence(lines, i + 1, fenceLen);
      if (closeIndex !== -1) {
        const code = lines.slice(i + 1, closeIndex).join("\n");
        const source = lines.slice(i, closeIndex + 1).join("\n");
        blocks.push({ type: "code", source, code });
        i = closeIndex + 1;
        continue;
      }
      const text = lines.slice(i).join("\n");
      blocks.push({ type: "paragraph", source: text, text, literal: true });
      break;
    }

    const firstList = matchListLine(line);
    if (firstList && firstList.indent <= 3) {
      const startLine = i;
      const topIndent = firstList.indent;
      const list: ListData = {
        kind: firstList.kind,
        start: firstList.kind === "ol" && firstList.start !== 1 ? firstList.start : undefined,
        items: [{ text: firstList.text }],
      };
      i++;

      while (i < lines.length) {
        const nextLine = lines[i] ?? "";
        if (nextLine.trim() === "" || matchFenceOpen(nextLine) !== null) {
          break;
        }
        const match = matchListLine(nextLine);
        if (!match) {
          break;
        }
        if (match.indent >= topIndent + 2) {
          const parent = list.items[list.items.length - 1];
          if (parent) {
            if (!parent.nested) parent.nested = [];
            let currentNested = parent.nested[parent.nested.length - 1];
            if (!currentNested || currentNested.kind !== match.kind) {
              currentNested = {
                kind: match.kind,
                start: match.kind === "ol" && match.start !== 1 ? match.start : undefined,
                items: [],
              };
              parent.nested.push(currentNested);
            }
            currentNested.items.push({ text: match.text });
          }
          i++;
          continue;
        }
        if (match.kind !== list.kind) {
          break;
        }
        list.items.push({ text: match.text });
        i++;
      }

      blocks.push({
        type: "list",
        source: lines.slice(startLine, i).join("\n"),
        list,
      });
      continue;
    }

    if (isAtxHeading(line) || isThematicBreak(line)) {
      blocks.push({ type: "paragraph", source: line, text: line, literal: true });
      i++;
      continue;
    }

    if (isBlockQuoteLine(line)) {
      const end = collectBlockQuote(lines, i);
      const text = lines.slice(i, end).join("\n");
      blocks.push({ type: "paragraph", source: text, text, literal: true });
      i = end;
      continue;
    }

    if (isTableStart(lines, i)) {
      const end = collectTable(lines, i);
      const text = lines.slice(i, end).join("\n");
      blocks.push({ type: "paragraph", source: text, text, literal: true });
      i = end;
      continue;
    }

    const blockStart = lineStarts[i] ?? 0;
    const paraLines: string[] = [line];
    i++;
    let literal = false;
    while (i < lines.length) {
      const nextLine = lines[i] ?? "";
      const currentEnd = (lineStarts[i] ?? normalized.length + 1) - 1;
      const inOpaqueHtml = isInsideOpaqueHtmlSpan(normalized, blockStart, currentEnd);
      if (!inOpaqueHtml && SETEXT_UNDERLINE_RE.test(nextLine)) {
        paraLines.push(nextLine);
        i++;
        literal = true;
        break;
      }
      if (isBlockBoundaryLine(lines, i) && !inOpaqueHtml) {
        break;
      }
      paraLines.push(nextLine);
      i++;
    }
    const text = paraLines.join("\n");
    blocks.push(
      literal
        ? { type: "paragraph", source: text, text, literal: true }
        : { type: "paragraph", source: text, text },
    );
  }

  return blocks;
}

const HTML_CLOSE_TAG_RE = /<\/[A-Za-z][A-Za-z0-9-]*\s*>/y;
const HTML_OPEN_TAG_RE =
  /<([A-Za-z][A-Za-z0-9-]*)(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>/y;

function findImageEnd(text: string, bangPos: number): number {
  let i = bangPos + 2;
  let bracketDepth = 0;
  let closeBracket = -1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\n") return -1;
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "[") {
      bracketDepth++;
    } else if (ch === "]") {
      if (bracketDepth === 0) {
        closeBracket = i;
        break;
      }
      bracketDepth--;
    }
    i++;
  }
  if (closeBracket === -1) return -1;

  const nextCh = text[closeBracket + 1];
  if (nextCh === "[") {
    let j = closeBracket + 2;
    while (j < text.length) {
      const ch = text[j];
      if (ch === "\n" || ch === "[") return -1;
      if (ch === "\\") {
        j += 2;
        continue;
      }
      if (ch === "]") return j + 1;
      j++;
    }
    return -1;
  }

  if (nextCh !== "(") return -1;

  let j = closeBracket + 2;
  while (j < text.length && (text[j] === " " || text[j] === "\t")) {
    j++;
  }
  if (j < text.length && text[j] === ")") {
    return j + 1;
  }

  if (text[j] === "<") {
    j++;
    let closedAngle = false;
    while (j < text.length) {
      const ch = text[j];
      if (ch === "\n" || ch === "<") return -1;
      if (ch === "\\") {
        j += 2;
        continue;
      }
      if (ch === ">") {
        j++;
        closedAngle = true;
        break;
      }
      j++;
    }
    if (!closedAngle) return -1;
  } else {
    const destStart = j;
    let parenDepth = 0;
    while (j < text.length) {
      const ch = text[j];
      if (ch === "\n") return -1;
      if (ch === " " || ch === "\t") break;
      if (ch === "\\") {
        j += 2;
        continue;
      }
      if (ch === "(") {
        parenDepth++;
      } else if (ch === ")") {
        if (parenDepth === 0) {
          return j + 1;
        }
        parenDepth--;
      }
      j++;
    }
    if (parenDepth !== 0 || j === destStart) return -1;
  }

  const wsStart = j;
  while (j < text.length && (text[j] === " " || text[j] === "\t")) {
    j++;
  }
  if (j >= text.length) return -1;
  if (text[j] === ")") return j + 1;
  if (j === wsStart) return -1;

  const quote = text[j];
  if (quote !== '"' && quote !== "'" && quote !== "(") return -1;
  const endQuote = quote === "(" ? ")" : quote;
  j++;
  let closedTitle = false;
  while (j < text.length) {
    const ch = text[j];
    if (ch === "\n") return -1;
    if (ch === "\\") {
      j += 2;
      continue;
    }
    if (quote === "(" && ch === "(") return -1;
    if (ch === endQuote) {
      j++;
      closedTitle = true;
      break;
    }
    j++;
  }
  if (!closedTitle) return -1;

  while (j < text.length && (text[j] === " " || text[j] === "\t")) {
    j++;
  }
  return text[j] === ")" ? j + 1 : -1;
}

function findOpaqueLiteralSpanEnd(text: string, pos: number): number {
  const ch = text[pos];
  if (ch === "!" && text[pos + 1] === "[") {
    return findImageEnd(text, pos);
  }

  if (ch === "<") {
    if (text.startsWith("<!--", pos)) {
      const commentEnd = text.indexOf("-->", pos + 4);
      return commentEnd !== -1 ? commentEnd + 3 : -1;
    }
    HTML_CLOSE_TAG_RE.lastIndex = pos;
    const closeMatch = HTML_CLOSE_TAG_RE.exec(text);
    if (closeMatch) {
      return closeMatch.index + closeMatch[0].length;
    }
    HTML_OPEN_TAG_RE.lastIndex = pos;
    const openMatch = HTML_OPEN_TAG_RE.exec(text);
    if (openMatch) {
      const tagEnd = openMatch.index + openMatch[0].length;
      const tagName = openMatch[1]?.toLowerCase();
      if ((tagName === "script" || tagName === "style") && !openMatch[0].endsWith("/>")) {
        const closeTagRe = new RegExp(`</${tagName}\\s*>`, "i");
        const restClose = closeTagRe.exec(text.slice(tagEnd));
        if (restClose) {
          return tagEnd + restClose.index + restClose[0].length;
        }
      }
      return tagEnd;
    }
  }

  return -1;
}

function isInsideOpaqueHtmlSpan(fullText: string, start: number, end: number): boolean {
  let pos = start;
  while (pos < end) {
    const ch = fullText[pos];
    if (ch === "`") {
      const codeClose = fullText.indexOf("`", pos + 1);
      if (codeClose !== -1 && !fullText.slice(pos + 1, codeClose).includes("\n")) {
        if (codeClose >= end) {
          return false;
        }
        pos = codeClose + 1;
        continue;
      }
    }
    if (ch === "<") {
      const opaqueEnd = findOpaqueLiteralSpanEnd(fullText, pos);
      if (opaqueEnd !== -1) {
        if (opaqueEnd > end) {
          return true;
        }
        pos = opaqueEnd;
        continue;
      }
    }
    pos++;
  }
  return false;
}

function findInlineClose(text: string, from: number, marker: "**" | "*"): number {
  let i = from;
  while (i < text.length) {
    const opaqueEnd = findOpaqueLiteralSpanEnd(text, i);
    if (opaqueEnd !== -1) {
      i = opaqueEnd;
      continue;
    }
    const ch = text[i];
    if (ch === "`") {
      const codeClose = text.indexOf("`", i + 1);
      if (codeClose !== -1 && !text.slice(i + 1, codeClose).includes("\n")) {
        i = codeClose + 1;
        continue;
      }
    }
    if (ch === "*") {
      let runEnd = i + 1;
      while (text[runEnd] === "*") {
        runEnd++;
      }
      const runLen = runEnd - i;
      if (marker === "**") {
        if (runLen >= 2 && i > from && !/\s/.test(text[i - 1] ?? "")) {
          return i;
        }
        if (runLen === 1 && runEnd < text.length && !/\s/.test(text[runEnd] ?? "")) {
          const nestedClose = findInlineClose(text, runEnd, "*");
          if (nestedClose !== -1) {
            i = nestedClose + 1;
            continue;
          }
        }
      } else {
        if (runLen === 2 && runEnd < text.length && !/\s/.test(text[runEnd] ?? "")) {
          const nestedClose = findInlineClose(text, runEnd, "**");
          if (nestedClose !== -1) {
            i = nestedClose + 2;
            continue;
          }
        }
        if ((runLen === 1 || runLen >= 3) && i > from && !/\s/.test(text[i - 1] ?? "")) {
          return i;
        }
      }
      i = runEnd;
      continue;
    }
    i++;
  }
  return -1;
}

function findLinkEnd(
  text: string,
  startBracket: number,
): { closeBracket: number; closeParen: number } | null {
  const closeBracket = text.indexOf("]", startBracket + 1);
  if (closeBracket === -1 || text.slice(startBracket + 1, closeBracket).includes("\n")) {
    return null;
  }
  if (text[closeBracket + 1] !== "(") {
    return null;
  }
  let depth = 1;
  let i = closeBracket + 2;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\n" || ch === " " || ch === "\t") {
      return null;
    }
    if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      depth--;
      if (depth === 0) {
        return { closeBracket, closeParen: i };
      }
    }
    i++;
  }
  return null;
}

function renderInline(parent: Node, text: string, allowLinks = true): void {
  let buf = "";
  const flush = () => {
    if (buf) {
      parent.appendChild(document.createTextNode(buf));
      buf = "";
    }
  };

  let pos = 0;
  while (pos < text.length) {
    const ch = text[pos] ?? "";

    if (ch === "\n") {
      if (buf.endsWith("  ")) {
        buf = buf.slice(0, -2);
      } else if (buf.endsWith("\\")) {
        buf = buf.slice(0, -1);
      }
      flush();
      parent.appendChild(document.createElement("br"));
      pos++;
      continue;
    }

    const opaqueEnd = findOpaqueLiteralSpanEnd(text, pos);
    if (opaqueEnd !== -1) {
      buf += text.slice(pos, opaqueEnd);
      pos = opaqueEnd;
      continue;
    }

    if (ch === "`") {
      const close = text.indexOf("`", pos + 1);
      if (close > pos + 1 && !text.slice(pos + 1, close).includes("\n")) {
        flush();
        const code = document.createElement("code");
        code.textContent = text.slice(pos + 1, close);
        parent.appendChild(code);
        pos = close + 1;
        continue;
      }
    }

    if (text.startsWith("**", pos) && pos + 2 < text.length && !/\s/.test(text[pos + 2] ?? "")) {
      const close = findInlineClose(text, pos + 2, "**");
      if (close !== -1) {
        flush();
        const strong = document.createElement("strong");
        renderInline(strong, text.slice(pos + 2, close), allowLinks);
        parent.appendChild(strong);
        pos = close + 2;
        continue;
      }
    }

    if (
      ch === "*" &&
      !text.startsWith("**", pos) &&
      pos + 1 < text.length &&
      !/\s/.test(text[pos + 1] ?? "")
    ) {
      const close = findInlineClose(text, pos + 1, "*");
      if (close !== -1) {
        flush();
        const em = document.createElement("em");
        renderInline(em, text.slice(pos + 1, close), allowLinks);
        parent.appendChild(em);
        pos = close + 1;
        continue;
      }
    }

    if (allowLinks && ch === "[" && (pos === 0 || text[pos - 1] !== "!")) {
      const linkBounds = findLinkEnd(text, pos);
      if (linkBounds) {
        const label = text.slice(pos + 1, linkBounds.closeBracket);
        const rawUrl = text.slice(linkBounds.closeBracket + 2, linkBounds.closeParen);
        const parsed = parseSafeHttpUrl(rawUrl);
        if (parsed) {
          flush();
          const a = document.createElement("a");
          a.className = "solv-md-link";
          a.href = parsed.href;
          a.target = "_blank";
          a.rel = "noopener noreferrer nofollow";
          renderInline(a, label, false);
          parent.appendChild(a);
          pos = linkBounds.closeParen + 1;
          continue;
        }
        buf += text.slice(pos, linkBounds.closeParen + 1);
        pos = linkBounds.closeParen + 1;
        continue;
      }
    }

    buf += ch;
    pos++;
  }

  flush();
}

function buildListElement(data: ListData): HTMLUListElement | HTMLOListElement {
  let listEl: HTMLUListElement | HTMLOListElement;
  if (data.kind === "ol") {
    const ol = document.createElement("ol");
    if (data.start !== undefined) {
      ol.start = data.start;
    }
    listEl = ol;
  } else {
    listEl = document.createElement("ul");
  }
  for (const item of data.items) {
    const li = document.createElement("li");
    renderInline(li, item.text);
    if (item.nested) {
      for (const nestedList of item.nested) {
        li.appendChild(buildListElement(nestedList));
      }
    }
    listEl.appendChild(li);
  }
  return listEl;
}

function buildCodeBlockElement(codeText: string): HTMLDivElement {
  const wrapper = document.createElement("div");
  wrapper.className = "solv-code-block";

  const header = document.createElement("div");
  header.className = "solv-code-header";

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "solv-copy-btn";
  copyBtn.textContent = "Copy";

  const status = document.createElement("span");
  status.className = "sr-only";
  status.setAttribute("aria-live", "polite");

  let resetTimer: ReturnType<typeof setTimeout> | undefined;
  copyBtn.addEventListener("click", async () => {
    if (typeof navigator === "undefined" || typeof navigator.clipboard?.writeText !== "function") {
      return;
    }
    try {
      await navigator.clipboard.writeText(codeText);
    } catch {
      return;
    }
    copyBtn.textContent = "Copied";
    status.textContent = "Copied";
    if (resetTimer !== undefined) {
      clearTimeout(resetTimer);
    }
    resetTimer = setTimeout(() => {
      copyBtn.textContent = "Copy";
      status.textContent = "";
      resetTimer = undefined;
    }, 2000);
  });

  header.append(copyBtn, status);

  const pre = document.createElement("pre");
  pre.className = "solv-code-pre";
  const code = document.createElement("code");
  code.textContent = codeText;
  pre.appendChild(code);

  wrapper.append(header, pre);
  return wrapper;
}

function buildBlockElement(block: ParsedBlock): HTMLElement {
  if (block.type === "code") {
    return buildCodeBlockElement(block.code);
  }
  if (block.type === "list") {
    return buildListElement(block.list);
  }
  const p = document.createElement("p");
  if (block.literal) {
    p.className = "solv-md-literal";
    p.textContent = block.text;
  } else {
    renderInline(p, block.text);
  }
  return p;
}

function nodesEqual(a: Node, b: Node): boolean {
  if (a.nodeType !== b.nodeType) return false;
  if (a.nodeType === Node.TEXT_NODE) return a.textContent === b.textContent;
  if (a instanceof Element && b instanceof Element) {
    if (a.tagName !== b.tagName) return false;
    if (a.getAttribute("href") !== b.getAttribute("href")) return false;
    if (a.childNodes.length !== b.childNodes.length) return false;
    for (let i = 0; i < a.childNodes.length; i++) {
      const aChild = a.childNodes[i];
      const bChild = b.childNodes[i];
      if (!aChild || !bChild || !nodesEqual(aChild, bChild)) return false;
    }
    return true;
  }
  return false;
}

function reconcileParagraph(prevEl: HTMLElement, nextEl: HTMLElement): void {
  if (prevEl.className !== nextEl.className) {
    if (nextEl.className) {
      prevEl.className = nextEl.className;
    } else {
      prevEl.removeAttribute("class");
    }
  }
  let k = 0;
  while (k < prevEl.childNodes.length && k < nextEl.childNodes.length) {
    const oldChild = prevEl.childNodes[k];
    const newChild = nextEl.childNodes[k];
    if (!oldChild || !newChild) break;

    if (oldChild instanceof Text && newChild instanceof Text) {
      if (oldChild.data === newChild.data) {
        k++;
        continue;
      }
      if (newChild.data.startsWith(oldChild.data)) {
        oldChild.appendData(newChild.data.slice(oldChild.data.length));
        k++;
        continue;
      }
      break;
    }

    if (nodesEqual(oldChild, newChild)) {
      k++;
      continue;
    }
    break;
  }

  while (prevEl.childNodes.length > k) {
    prevEl.lastChild?.remove();
  }
  while (nextEl.childNodes.length > k) {
    const child = nextEl.childNodes[k];
    if (child) {
      prevEl.appendChild(child);
    } else {
      break;
    }
  }
}

interface RenderedBlock {
  source: string;
  el: HTMLElement;
}

const renderedState = new WeakMap<HTMLElement, RenderedBlock[]>();

/**
 * Renders the supported Markdown subset into `container` using DOM nodes only.
 * Preserves unchanged leading blocks and extends trailing text nodes in place
 * so streaming updates avoid flicker and preserve text selection.
 */
export function renderMarkdown(container: HTMLElement, markdown: string): void {
  const blocks = parseBlocks(markdown);
  const existing = renderedState.get(container);
  const prev = existing && existing.length === container.childNodes.length ? existing : [];

  if (prev.length === 0 && container.childNodes.length > 0) {
    container.replaceChildren();
  }

  let common = 0;
  while (
    common < prev.length &&
    common < blocks.length &&
    prev[common]?.source === blocks[common]?.source
  ) {
    common++;
  }

  for (let i = common; i < Math.min(prev.length, blocks.length); i++) {
    const prevItem = prev[i];
    const nextBlock = blocks[i];
    if (!prevItem || !nextBlock) continue;

    const nextEl = buildBlockElement(nextBlock);
    if (i === common && prevItem.el.tagName === "P" && nextBlock.type === "paragraph") {
      reconcileParagraph(prevItem.el, nextEl);
      prevItem.source = nextBlock.source;
    } else {
      prevItem.el.replaceWith(nextEl);
      prev[i] = { source: nextBlock.source, el: nextEl };
    }
  }

  for (let i = prev.length; i < blocks.length; i++) {
    const nextBlock = blocks[i];
    if (!nextBlock) continue;
    const nextEl = buildBlockElement(nextBlock);
    container.appendChild(nextEl);
    prev.push({ source: nextBlock.source, el: nextEl });
  }

  if (prev.length > blocks.length) {
    const removed = prev.splice(blocks.length);
    for (const item of removed) {
      item.el.remove();
    }
  }

  renderedState.set(container, prev);
}
