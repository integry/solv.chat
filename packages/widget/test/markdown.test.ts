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

  it("renders nested bold inside italic in both single and incremental renders", () => {
    const input = "*outer **bold** end*";
    const single = document.createElement("div");
    renderMarkdown(single, input);

    const em = single.querySelector("p > em");
    expect(em).not.toBeNull();
    expect(em?.textContent).toBe("outer bold end");
    expect(em?.querySelector("strong")?.textContent).toBe("bold");
    expect(single.textContent).toBe("outer bold end");

    const incremental = document.createElement("div");
    for (let len = 1; len <= input.length; len++) {
      renderMarkdown(incremental, input.slice(0, len));
    }
    expect(serializeDom(incremental)).toEqual(serializeDom(single));

    const multi = document.createElement("div");
    renderMarkdown(
      multi,
      "*outer **bold** and **more** end* and **outer *italic* end** and *outer **unclosed end*",
    );
    const ems = multi.querySelectorAll("p > em");
    expect(ems).toHaveLength(2);
    expect(ems[0]?.querySelectorAll("strong")).toHaveLength(2);
    expect(ems[1]?.textContent).toBe("outer **unclosed end");
    expect(multi.querySelector("p > strong > em")?.textContent).toBe("italic");

    for (const adjacent of ["**outer *italic***", "*outer **bold***", "***both***"]) {
      const adjSingle = document.createElement("div");
      renderMarkdown(adjSingle, adjacent);
      expect(adjSingle.textContent).not.toContain("*");

      const adjIncremental = document.createElement("div");
      for (let len = 1; len <= adjacent.length; len++) {
        renderMarkdown(adjIncremental, adjacent.slice(0, len));
      }
      expect(serializeDom(adjIncremental)).toEqual(serializeDom(adjSingle));
    }

    const boldOuter = document.createElement("div");
    renderMarkdown(boldOuter, "**outer *italic***");
    expect(boldOuter.querySelector("p > strong > em")?.textContent).toBe("italic");
    expect(boldOuter.querySelector("p > strong")?.textContent).toBe("outer italic");

    const unclosedInner = document.createElement("div");
    renderMarkdown(unclosedInner, "**outer *unclosed**");
    expect(unclosedInner.querySelector("p > strong")?.textContent).toBe("outer *unclosed");
    expect(unclosedInner.querySelector("em")).toBeNull();
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

  it("renders fenced code blocks without highlighting, with a Copy button that announces Copied only after writeText resolves", async () => {
    vi.useFakeTimers();
    let resolveWrite: (() => void) | undefined;
    const writeText = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveWrite = resolve;
        }),
    );
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
    // Success feedback must not appear before the clipboard write settles.
    expect(copyBtn?.textContent).toBe("Copy");
    expect(live?.textContent).toBe("");

    resolveWrite?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(copyBtn?.textContent).toBe("Copied");
    expect(live?.textContent).toBe("Copied");

    vi.advanceTimersByTime(2000);
    expect(copyBtn?.textContent).toBe("Copy");
    expect(live?.textContent).toBe("");
  });

  it("does not announce Copied when clipboard access is unavailable or writeText rejects", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: undefined,
      configurable: true,
    });

    const container = document.createElement("div");
    renderMarkdown(container, "```ts\nconst x = 1;\n```");

    const copyBtn = container.querySelector<HTMLButtonElement>("button.solv-copy-btn");
    const live = container.querySelector<HTMLElement>('[aria-live="polite"]');

    copyBtn?.click();
    await Promise.resolve();
    expect(copyBtn?.textContent).toBe("Copy");
    expect(live?.textContent).toBe("");

    const writeText = vi.fn(async () => {
      throw new Error("Clipboard denied");
    });
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    copyBtn?.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith("const x = 1;");
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

  it("preserves inline Markdown delimiters inside unsupported headings, block quotes, and tables literally", () => {
    const markdown = [
      "# **Heading**",
      "## *Subheading* with `code` and [link](https://example.com)",
      "",
      "**Setext** heading",
      "===",
      "",
      "*Sub* heading",
      "---",
      "",
      "> *Quoted text*",
      "> **Bold quote** and `inline` and [site](https://example.com)",
      "> > - Quoted list item",
      "lazy *continuation*",
      "",
      "| Col A | Col B |",
      "| --- | --- |",
      '| `print("a  b")` | **bold** and *em* and [link](https://example.com) |',
      "",
      "Header **one** | *two*",
      ":--- | ---:",
      "`cell` | *value*",
    ].join("\n");

    const container = document.createElement("div");
    renderMarkdown(container, markdown);

    expect(
      container.querySelector("h1, h2, table, blockquote, strong, em, code, a, ul, li"),
    ).toBeNull();
    const literals = container.querySelectorAll("p.solv-md-literal");
    expect(literals).toHaveLength(7);
    expect(literals[0]?.textContent).toBe("# **Heading**");
    expect(literals[1]?.textContent).toBe(
      "## *Subheading* with `code` and [link](https://example.com)",
    );
    expect(literals[2]?.textContent).toBe("**Setext** heading\n===");
    expect(literals[3]?.textContent).toBe("*Sub* heading\n---");
    expect(literals[4]?.textContent).toBe(
      [
        "> *Quoted text*",
        "> **Bold quote** and `inline` and [site](https://example.com)",
        "> > - Quoted list item",
        "lazy *continuation*",
      ].join("\n"),
    );
    expect(literals[5]?.textContent).toBe(
      [
        "| Col A | Col B |",
        "| --- | --- |",
        '| `print("a  b")` | **bold** and *em* and [link](https://example.com) |',
      ].join("\n"),
    );
    expect(literals[6]?.textContent).toBe(
      ["Header **one** | *two*", ":--- | ---:", "`cell` | *value*"].join("\n"),
    );

    const incremental = document.createElement("div");
    for (let len = 1; len <= markdown.length; len++) {
      renderMarkdown(incremental, markdown.slice(0, len));
    }
    expect(serializeDom(incremental)).toEqual(serializeDom(container));
  });

  it("keeps supported blocks around headings, block quotes, and tables formatted while keeping unsupported blocks literal", () => {
    const container = document.createElement("div");
    renderMarkdown(
      container,
      [
        "Before **bold**",
        "# **Heading**",
        "Middle *italic*",
        "> *Quoted text*",
        "- List **item**",
        "| Col A | Col B |",
        "| --- | --- |",
        "| `code` | *em* |",
        "After **bold** and #hashtag",
        "",
        "| **Not a table** | still bold |",
      ].join("\n"),
    );

    expect(container.querySelectorAll("strong")).toHaveLength(4);
    expect(container.querySelectorAll("em")).toHaveLength(1);
    expect(container.querySelectorAll("code")).toHaveLength(0);
    expect(container.querySelectorAll("ul > li")).toHaveLength(1);

    const literals = container.querySelectorAll("p.solv-md-literal");
    expect(literals).toHaveLength(3);
    expect(literals[0]?.textContent).toBe("# **Heading**");
    expect(literals[1]?.textContent).toBe("> *Quoted text*");
    expect(literals[2]?.textContent).toBe("| Col A | Col B |\n| --- | --- |\n| `code` | *em* |");
  });

  it("keeps empty or non-paragraph block quotes from absorbing following lines as lazy continuations", () => {
    const container = document.createElement("div");
    renderMarkdown(
      container,
      [
        ">",
        "**Not quoted**",
        "",
        "> # Quoted heading",
        "*Also not quoted*",
        "",
        "> ```ts",
        "> const x = 1;",
        "**After quote fence**",
      ].join("\n"),
    );

    expect(container.querySelector("p:nth-child(2) strong")?.textContent).toBe("Not quoted");
    expect(container.querySelector("p:nth-child(4) em")?.textContent).toBe("Also not quoted");
    expect(container.querySelector("p:nth-child(6) strong")?.textContent).toBe("After quote fence");
  });

  it("preserves Markdown delimiters inside unsupported image and raw HTML constructs literally", () => {
    const container = document.createElement("div");
    renderMarkdown(
      container,
      [
        "![**diagram**](https://example.com/image.png)",
        "![*alt* and `code`](https://example.com/a*b*.png)",
        '<img alt="**diagram**" src=x>',
        '<span data-note="*hint*">ok</span>',
        "<!-- **comment** -->",
        '<script>const s = "**x**";</script>',
        '**wrap <img alt="a**b" src=x> and ![c**d](https://example.com/x.png) end**',
        "1 < 2 and **still bold** > 0",
        '![**diagram**](https://example.com/image.png "Caption")',
        "![*alt*](https://example.com/image.png 'Single \"title\"')",
        "![*alt*](https://example.com/image.png (Paren title))",
        '![**diagram**](<https://example.com/my image.png> "Caption")',
        "![**diagram**][figure]",
        "![*collapsed*][]",
        '**wrap ![**diagram**](https://example.com/image.png "Caption") and ![*ref*][figure] end**',
      ].join("\n\n"),
    );

    expect(container.querySelectorAll("img, a, span, script")).toHaveLength(0);
    expect(container.querySelectorAll("em, code")).toHaveLength(0);

    const paragraphs = container.querySelectorAll("p");
    expect(paragraphs).toHaveLength(15);
    expect(paragraphs[0]?.querySelector("strong")).toBeNull();
    expect(paragraphs[0]?.textContent).toBe("![**diagram**](https://example.com/image.png)");
    expect(paragraphs[1]?.textContent).toBe("![*alt* and `code`](https://example.com/a*b*.png)");
    expect(paragraphs[2]?.querySelector("strong")).toBeNull();
    expect(paragraphs[2]?.textContent).toBe('<img alt="**diagram**" src=x>');
    expect(paragraphs[3]?.querySelector("em")).toBeNull();
    expect(paragraphs[3]?.textContent).toBe('<span data-note="*hint*">ok</span>');
    expect(paragraphs[4]?.querySelector("strong")).toBeNull();
    expect(paragraphs[4]?.textContent).toBe("<!-- **comment** -->");
    expect(paragraphs[5]?.querySelector("strong")).toBeNull();
    expect(paragraphs[5]?.textContent).toBe('<script>const s = "**x**";</script>');
    expect(paragraphs[6]?.querySelector("strong")?.textContent).toBe(
      'wrap <img alt="a**b" src=x> and ![c**d](https://example.com/x.png) end',
    );
    expect(paragraphs[7]?.querySelector("strong")?.textContent).toBe("still bold");
    expect(paragraphs[8]?.querySelector("strong")).toBeNull();
    expect(paragraphs[8]?.textContent).toBe(
      '![**diagram**](https://example.com/image.png "Caption")',
    );
    expect(paragraphs[9]?.textContent).toBe(
      "![*alt*](https://example.com/image.png 'Single \"title\"')",
    );
    expect(paragraphs[10]?.textContent).toBe(
      "![*alt*](https://example.com/image.png (Paren title))",
    );
    expect(paragraphs[11]?.querySelector("strong")).toBeNull();
    expect(paragraphs[11]?.textContent).toBe(
      '![**diagram**](<https://example.com/my image.png> "Caption")',
    );
    expect(paragraphs[12]?.querySelector("strong")).toBeNull();
    expect(paragraphs[12]?.textContent).toBe("![**diagram**][figure]");
    expect(paragraphs[13]?.textContent).toBe("![*collapsed*][]");
    expect(paragraphs[14]?.querySelector("strong")?.textContent).toBe(
      'wrap ![**diagram**](https://example.com/image.png "Caption") and ![*ref*][figure] end',
    );
  });

  it("preserves opaque script, style, and comment spans across blank lines and block-level markers", () => {
    const container = document.createElement("div");
    const scriptBlock = "<script>\n\n**literal**\n\n- item\n\n</script>";
    const styleBlock = "<style>\n\n**literal**\n\n```js\ncode\n```\n\n</style>";
    const commentBlock = "<!--\n\n**literal**\n\n-->";
    renderMarkdown(
      container,
      [scriptBlock, styleBlock, commentBlock, "After **bold**"].join("\n\n"),
    );

    expect(container.querySelectorAll("script, style, ul, li, pre")).toHaveLength(0);
    const paragraphs = container.querySelectorAll("p");
    expect(paragraphs).toHaveLength(4);
    expect(paragraphs[0]?.querySelector("strong")).toBeNull();
    expect(paragraphs[0]?.textContent).toBe(scriptBlock);
    expect(paragraphs[1]?.querySelector("strong")).toBeNull();
    expect(paragraphs[1]?.textContent).toBe(styleBlock);
    expect(paragraphs[2]?.querySelector("strong")).toBeNull();
    expect(paragraphs[2]?.textContent).toBe(commentBlock);
    expect(paragraphs[3]?.querySelector("strong")?.textContent).toBe("bold");
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

  it("keeps unfinished fenced contents literal when containing emphasis, list markers, and inline backticks", () => {
    const container = document.createElement("div");
    const body = "**literal** and *italic*\n- item\n1. numbered\n`inline`";

    renderMarkdown(container, `\`\`\`md\n${body}`);
    expect(container.querySelector("strong, em, ul, ol, li, code, .solv-code-block")).toBeNull();
    expect(container.textContent).toBe(`\`\`\`md\n${body}`);

    // Also when interrupting a paragraph without a blank line.
    renderMarkdown(container, `Intro\n\`\`\`md\n${body}`);
    expect(container.querySelector("strong, em, ul, ol, li, code, .solv-code-block")).toBeNull();
    expect(container.children[0]?.textContent).toBe("Intro");
    expect(container.children[1]?.textContent).toBe(`\`\`\`md\n${body}`);

    // Once closed, it transitions to a code block with the exact raw contents.
    renderMarkdown(container, `Intro\n\`\`\`md\n${body}\n\`\`\``);
    expect(container.querySelector(".solv-code-block code")?.textContent).toBe(body);
  });

  it("updates literal class when a streaming paragraph transitions into or out of an unfinished fence", () => {
    const container = document.createElement("div");

    renderMarkdown(container, "`");
    const para = container.querySelector("p");
    expect(para?.classList.contains("solv-md-literal")).toBe(false);

    renderMarkdown(container, "```ts\n  const x = 1;");
    expect(container.querySelector("p")).toBe(para);
    expect(para?.classList.contains("solv-md-literal")).toBe(true);

    renderMarkdown(container, "```ts`");
    expect(container.querySelector("p")).toBe(para);
    expect(para?.classList.contains("solv-md-literal")).toBe(false);
  });

  it("preserves newlines and indentation for unterminated fences inside an assistant bubble during streaming and after restore", async () => {
    const unfinishedFence = "```ts\nfunction demo() {\n  return 1;\n}";
    const chunks = [
      `event: token\ndata: ${JSON.stringify({ text: "```ts\nfunction demo() {\n" })}\n\n`,
      `event: token\ndata: ${JSON.stringify({ text: "  return 1;\n}" })}\n\n`,
      'event: done\ndata: {"messageId":"m_fence","conversationId":"c_fence"}\n\n',
    ];

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/v1/chat")) {
        return new Response(sseStream(chunks), { status: 200 });
      }
      return Response.json({});
    }) as typeof fetch;

    const liveEl = mountWidget("pk_md_unfinished");
    await flushAsync();
    const liveRoot = shadow(liveEl);
    mustQuery<HTMLButtonElement>(liveRoot, ".solv-launcher").click();
    mustQuery<HTMLTextAreaElement>(liveRoot, "#solv-input").value = "Show code";
    mustQuery<HTMLFormElement>(liveRoot, ".solv-form").requestSubmit();
    await flushAsync();

    const liveLiteral = mustQuery<HTMLParagraphElement>(
      liveRoot,
      ".solv-bubble--assistant .solv-bubble-text p.solv-md-literal",
    );
    expect(liveLiteral.textContent).toBe(unfinishedFence);
    expect(getComputedStyle(liveLiteral).whiteSpace).toBe("pre-wrap");

    liveEl.remove();
    const restoredEl = mountWidget("pk_md_unfinished");
    await flushAsync();
    const restoredRoot = shadow(restoredEl);
    const restoredLiteral = mustQuery<HTMLParagraphElement>(
      restoredRoot,
      ".solv-bubble--assistant .solv-bubble-text p.solv-md-literal",
    );
    expect(restoredLiteral.textContent).toBe(unfinishedFence);
    expect(getComputedStyle(restoredLiteral).whiteSpace).toBe("pre-wrap");
  });

  it("preserves repeated spaces inside inline code and keeps unsupported blocks literal in assistant bubbles", async () => {
    const answer = [
      'Run `print("a  b")` and check:',
      "",
      "- Item with `a   b`",
      "",
      "# **Heading**",
      "",
      "> *Quoted text*",
      "",
      "| Col A | Col B |",
      "| --- | --- |",
      '| `print("c  d")` | *em* |',
    ].join("\n");

    const chunks =
      answer
        .match(/.{1,10}/gs)
        ?.map((part) => `event: token\ndata: ${JSON.stringify({ text: part })}\n\n`) ?? [];
    chunks.push('event: done\ndata: {"messageId":"m_ws","conversationId":"c_ws"}\n\n');

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/v1/chat")) {
        return new Response(sseStream(chunks), { status: 200 });
      }
      return Response.json({});
    }) as typeof fetch;

    const liveEl = mountWidget("pk_md_whitespace");
    await flushAsync();
    const liveRoot = shadow(liveEl);
    mustQuery<HTMLButtonElement>(liveRoot, ".solv-launcher").click();
    mustQuery<HTMLTextAreaElement>(liveRoot, "#solv-input").value = "Format check";
    mustQuery<HTMLFormElement>(liveRoot, ".solv-form").requestSubmit();
    await flushAsync();

    const assertBubble = (root: ShadowRoot) => {
      const bubbleText = mustQuery<HTMLDivElement>(
        root,
        ".solv-bubble--assistant .solv-bubble-text",
      );
      expect(getComputedStyle(bubbleText).whiteSpace).toBe("normal");

      const inlineCodes = bubbleText.querySelectorAll("code");
      expect(inlineCodes).toHaveLength(2);
      expect(inlineCodes[0]?.textContent).toBe('print("a  b")');
      expect(inlineCodes[1]?.textContent).toBe("a   b");
      for (const code of inlineCodes) {
        expect(getComputedStyle(code).whiteSpace).toBe("pre-wrap");
      }

      expect(bubbleText.querySelector("h1, blockquote, table, strong, em")).toBeNull();
      const literals = bubbleText.querySelectorAll<HTMLParagraphElement>("p.solv-md-literal");
      expect(literals).toHaveLength(3);
      expect(literals[0]?.textContent).toBe("# **Heading**");
      expect(literals[1]?.textContent).toBe("> *Quoted text*");
      expect(literals[2]?.textContent).toBe(
        '| Col A | Col B |\n| --- | --- |\n| `print("c  d")` | *em* |',
      );
      for (const literal of literals) {
        expect(getComputedStyle(literal).whiteSpace).toBe("pre-wrap");
      }
    };

    assertBubble(liveRoot);

    liveEl.remove();
    const restoredEl = mountWidget("pk_md_whitespace");
    await flushAsync();
    assertBubble(shadow(restoredEl));
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
