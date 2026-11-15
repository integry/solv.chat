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
  | { type: "paragraph"; source: string; text: string }
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

function measureIndent(prefix: string): number {
  let count = 0;
  for (const ch of prefix) {
    count += ch === "\t" ? 2 : 1;
  }
  return count;
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

function isClosedFenceAt(lines: string[], index: number): boolean {
  const line = lines[index] ?? "";
  const open = FENCE_OPEN_RE.exec(line);
  if (!open) return false;
  const info = open[2] ?? "";
  if (info.includes("`")) return false;
  return findClosingFence(lines, index + 1, open[1]?.length ?? 3) !== -1;
}

function parseBlocks(markdown: string): ParsedBlock[] {
  const normalized = markdown.replace(/\r\n?/g, "\n");
  if (!normalized) return [];

  const lines = normalized.split("\n");
  const blocks: ParsedBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    if (line.trim() === "") {
      i++;
      continue;
    }

    const fenceOpen = FENCE_OPEN_RE.exec(line);
    if (fenceOpen && !(fenceOpen[2] ?? "").includes("`")) {
      const fenceLen = fenceOpen[1]?.length ?? 3;
      const closeIndex = findClosingFence(lines, i + 1, fenceLen);
      if (closeIndex !== -1) {
        const code = lines.slice(i + 1, closeIndex).join("\n");
        const source = lines.slice(i, closeIndex + 1).join("\n");
        blocks.push({ type: "code", source, code });
        i = closeIndex + 1;
        continue;
      }
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
        if (nextLine.trim() === "" || isClosedFenceAt(lines, i)) {
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

    const paraLines: string[] = [line];
    i++;
    while (i < lines.length) {
      const nextLine = lines[i] ?? "";
      if (nextLine.trim() === "" || isClosedFenceAt(lines, i)) {
        break;
      }
      const nextList = matchListLine(nextLine);
      if (nextList && nextList.indent <= 3) {
        break;
      }
      paraLines.push(nextLine);
      i++;
    }
    const text = paraLines.join("\n");
    blocks.push({ type: "paragraph", source: text, text });
  }

  return blocks;
}

function findInlineClose(text: string, from: number, marker: "**" | "*"): number {
  let i = from;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "`") {
      const codeClose = text.indexOf("`", i + 1);
      if (codeClose !== -1 && !text.slice(i + 1, codeClose).includes("\n")) {
        i = codeClose + 1;
        continue;
      }
    }
    if (marker === "**") {
      if (text.startsWith("**", i) && i > from && !/\s/.test(text[i - 1] ?? "")) {
        return i;
      }
    } else if (
      ch === "*" &&
      !text.startsWith("**", i) &&
      i > from &&
      !/\s/.test(text[i - 1] ?? "")
    ) {
      return i;
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
  copyBtn.addEventListener("click", () => {
    void navigator.clipboard?.writeText(codeText).catch(() => {});
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
  renderInline(p, block.text);
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
