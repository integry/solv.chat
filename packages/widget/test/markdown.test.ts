import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderMarkdown } from "../src/markdown.js";
import "../src/widget.js";

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

function mountWidget(assistant = "pk_md_1"): HTMLElement {
  const el = document.createElement("solv-chat");
  el.setAttribute("assistant", assistant);
  document.body.append(el);
  return el;
}

function shadow(el: HTMLElement): ShadowRoot {
  const root = el.shadowRoot;
  if (!root) throw new Error("Expected shadowRoot");
  return root;
}

function mustQuery<T extends Element>(root: ParentNode, selector: string): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`Missing element: ${selector}`);
  return el;
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function serializeDom(node: Node): unknown {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent;
  }
  if (node instanceof Element) {
    const attrs: Record<string, string> = {};
    for (const attr of Array.from(node.attributes)) {
      attrs[attr.name] = attr.value;
    }
    return {
      tag: node.tagName.toLowerCase(),
      attrs,
      children: Array.from(node.childNodes).map(serializeDom),
    };
  }
  return null;
}

describe("Markdown rendering", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    document.body.replaceChildren();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("renders paragraphs, line breaks, bold, italic, and inline code", () => {
    const container = document.createElement("div");
    renderMarkdown(
      container,
      "First line\nSecond line  \nThird line\n\nSecond **bold** and *italic* and `inline **code**`.",
    );

    const paragraphs = container.querySelectorAll("p");
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]?.querySelectorAll("br")).toHaveLength(2);
    expect(paragraphs[0]?.textContent).toBe("First lineSecond lineThird line");

    expect(paragraphs[1]?.querySelector("strong")?.textContent).toBe("bold");
    expect(paragraphs[1]?.querySelector("em")?.textContent).toBe("italic");
    expect(paragraphs[1]?.querySelector("code")?.textContent).toBe("inline **code**");
    expect(paragraphs[1]?.querySelector("code strong")).toBeNull();
  });

  it("renders unordered and ordered lists with one level of nesting", () => {
    const container = document.createElement("div");
    renderMarkdown(
      container,
      [
        "- Item one",
        "  - Nested bullet",
        "    - Deep bullet flattened to level 1",
        "  1. Nested numbered",
        "- Item two",
        "",
        "1. First",
        "   - Sub bullet",
        "2. Second",
      ].join("\n"),
    );

    const topUl = container.children[0];
    expect(topUl?.tagName).toBe("UL");
    expect(topUl?.children).toHaveLength(2);

    const firstLi = topUl?.children[0];
    expect(firstLi?.querySelector("ul")?.children).toHaveLength(2);
    expect(firstLi?.querySelector("ol")?.children).toHaveLength(1);
    // Never nests deeper than 1 level.
    expect(container.querySelector("ul ul ul")).toBeNull();

    const topOl = container.children[1];
    expect(topOl?.tagName).toBe("OL");
    expect(topOl?.children).toHaveLength(2);
    expect(topOl?.children[0]?.querySelector("ul > li")?.textContent).toBe("Sub bullet");
  });

  it("renders fenced code blocks without highlighting, with a Copy button that announces Copied", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    const container = document.createElement("div");
    renderMarkdown(container, "```ts\nconst x = 1;\nconsole.log(x);\n```");

    const block = container.querySelector(".solv-code-block");
    expect(block).not.toBeNull();
    const pre = block?.querySelector<HTMLPreElement>("pre.solv-code-pre");
    const code = pre?.querySelector("code");
    expect(code?.textContent).toBe("const x = 1;\nconsole.log(x);");
    expect(code?.querySelectorAll("*")).toHaveLength(0);

    const copyBtn = block?.querySelector<HTMLButtonElement>("button.solv-copy-btn");
    expect(copyBtn).not.toBeNull();
    expect(copyBtn?.type).toBe("button");
    expect(copyBtn?.textContent).toBe("Copy");

    const live = block?.querySelector<HTMLElement>('[aria-live="polite"]');
    expect(live).not.toBeNull();
    expect(live?.textContent).toBe("");

    copyBtn?.click();
    expect(writeText).toHaveBeenCalledWith("const x = 1;\nconsole.log(x);");
    expect(copyBtn?.textContent).toBe("Copied");
    expect(live?.textContent).toBe("Copied");

    vi.advanceTimersByTime(2000);
    expect(copyBtn?.textContent).toBe("Copy");
    expect(live?.textContent).toBe("");
  });

  it("renders http and https links with safe rel/target and leaves javascript:, data:, and other schemes as text", () => {
    const container = document.createElement("div");
    renderMarkdown(
      container,
      [
        "Visit [Docs](https://docs.example.com/path_(v1)) or [Local](http://localhost:3000).",
        "Bad [JS](javascript:alert(1)) and [Data](data:text/html,<script>alert(1)</script>) and [Mail](mailto:a@b.com).",
      ].join("\n\n"),
    );

    const links = container.querySelectorAll<HTMLAnchorElement>("a");
    expect(links).toHaveLength(2);
    expect(links[0]?.href).toBe("https://docs.example.com/path_(v1)");
    expect(links[0]?.target).toBe("_blank");
    expect(links[0]?.rel).toBe("noopener noreferrer nofollow");
    expect(links[0]?.textContent).toBe("Docs");

    expect(links[1]?.href).toBe("http://localhost:3000/");
    expect(links[1]?.target).toBe("_blank");
    expect(links[1]?.rel).toBe("noopener noreferrer nofollow");

    expect(container.textContent).toContain("[JS](javascript:alert(1))");
    expect(container.textContent).toContain("[Data](data:text/html,<script>alert(1)</script>)");
    expect(container.textContent).toContain("[Mail](mailto:a@b.com)");
    expect(container.querySelector("script")).toBeNull();
  });

  it("keeps unsupported constructs (headings, tables, images, block quotes, raw HTML) as literal text", () => {
    const container = document.createElement("div");
    renderMarkdown(
      container,
      [
        "# Heading 1",
        "## Heading 2",
        "",
        "| Col A | Col B |",
        "| --- | --- |",
        "| 1 | 2 |",
        "",
        "![Alt text](https://example.com/image.png)",
        "",
        "> Quoted text",
        "",
        '<img onerror="alert(1)" src=x> and <script>alert(1)</script>',
      ].join("\n"),
    );

    expect(container.querySelector("h1, h2, table, img, blockquote, script")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("# Heading 1");
    expect(container.textContent).toContain("## Heading 2");
    expect(container.textContent).toContain("| Col A | Col B |");
    expect(container.textContent).toContain("![Alt text](https://example.com/image.png)");
    expect(container.textContent).toContain("> Quoted text");
    expect(container.textContent).toContain('<img onerror="alert(1)" src=x>');
    expect(container.textContent).toContain("<script>alert(1)</script>");
  });

  it("renders unterminated constructs as plain text mid-stream until closed and preserves existing DOM nodes", () => {
    const container = document.createElement("div");

    renderMarkdown(container, "Intro paragraph.\n\n```js\nconst a = 1;");
    const firstPara = container.children[0];
    expect(firstPara?.tagName).toBe("P");
    // Unterminated fence renders as plain text, not a code block.
    expect(container.querySelector(".solv-code-block")).toBeNull();
    expect(container.textContent).toContain("```js");
    expect(container.textContent).toContain("const a = 1;");

    // Unterminated link renders as plain text.
    renderMarkdown(container, "Intro paragraph.\n\nSee [the guide](https://example.com");
    expect(container.children[0]).toBe(firstPara);
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("[the guide](https://example.com");

    // Once closed, the code block renders and the earlier paragraph node is preserved.
    renderMarkdown(container, "Intro paragraph.\n\n```js\nconst a = 1;\n```");
    expect(container.children[0]).toBe(firstPara);
    expect(container.querySelector(".solv-code-block code")?.textContent).toBe("const a = 1;");
  });

  it("keeps user bubbles as plain text and produces identical output for streamed and restored assistant transcripts", async () => {
    const markdownAnswer = [
      "Here is **bold**, *italic*, `code`, and [a link](https://example.com).",
      "",
      "- One",
      "  - Nested",
      "1. First",
      "",
      "```ts",
      "const ok = true;",
      "```",
    ].join("\n");

    const chunks =
      markdownAnswer
        .match(/.{1,12}/gs)
        ?.map((part) => `event: token\ndata: ${JSON.stringify({ text: part })}\n\n`) ?? [];
    chunks.push('event: done\ndata: {"messageId":"m_md","conversationId":"c_md"}\n\n');

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/v1/chat")) {
        return new Response(sseStream(chunks), { status: 200 });
      }
      return Response.json({});
    }) as typeof fetch;

    const liveEl = mountWidget("pk_md_restore");
    await flushAsync();
    const liveRoot = shadow(liveEl);
    mustQuery<HTMLButtonElement>(liveRoot, ".solv-launcher").click();

    const userInput = "**not bold** [not a link](https://example.com) <script>x</script>";
    mustQuery<HTMLTextAreaElement>(liveRoot, "#solv-input").value = userInput;
    mustQuery<HTMLFormElement>(liveRoot, ".solv-form").requestSubmit();
    await flushAsync();

    const liveUserText = liveRoot.querySelector(".solv-bubble--user .solv-bubble-text");
    expect(liveUserText?.textContent).toBe(userInput);
    expect(liveUserText?.querySelector("strong, a, script")).toBeNull();

    const liveAssistantText = mustQuery(liveRoot, ".solv-bubble--assistant .solv-bubble-text");
    const liveTree = serializeDom(liveAssistantText);

    liveEl.remove();
    const restoredEl = mountWidget("pk_md_restore");
    await flushAsync();
    const restoredRoot = shadow(restoredEl);

    const restoredUserText = restoredRoot.querySelector(".solv-bubble--user .solv-bubble-text");
    expect(restoredUserText?.textContent).toBe(userInput);
    expect(restoredUserText?.querySelector("strong, a, script")).toBeNull();

    const restoredAssistantText = mustQuery(
      restoredRoot,
      ".solv-bubble--assistant .solv-bubble-text",
    );
    expect(serializeDom(restoredAssistantText)).toEqual(liveTree);
  });

  it("contains no innerHTML, outerHTML, insertAdjacentHTML, document.write, or DOMParser in packages/widget/src", () => {
    const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
    const files = readdirSync(srcDir).filter((name) => name.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);

    const forbidden = /\b(innerHTML|outerHTML|insertAdjacentHTML|document\.write|DOMParser)\b/;
    for (const file of files) {
      const content = readFileSync(path.join(srcDir, file), "utf8");
      expect(content, `Forbidden DOM HTML API in ${file}`).not.toMatch(forbidden);
    }
  });
});
