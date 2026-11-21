import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Assistant } from "../src/api/types.js";
import { InlineLinks } from "../src/shell/InlineLinks.js";
import { TryItPane } from "../src/shell/TryItPane.js";

const ASSISTANT: Assistant = {
  id: "ast_1",
  orgId: "org_00000000000000000000",
  name: "Docs Bot",
  publicKey: "pk_ast_1",
  allowedOrigins: [],
  hasIngestKey: false,
  createdAt: 1_700_000_000_000,
};

/** A preview reply made of these token texts and nothing else: no citation events. */
function stubDraftChat(tokens: string[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const raw =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const url = new URL(raw, "https://example.com");
      if (url.pathname === "/api/admin/chat") {
        const sse = [
          ...tokens.map((text) => `event: token\ndata: ${JSON.stringify({ text })}\n\n`),
          `event: done\ndata: ${JSON.stringify({ messageId: "msg_try", conversationId: "cnv_try" })}\n\n`,
        ].join("");
        return new Response(sse, { headers: { "content-type": "text/event-stream" } });
      }
      return Response.json({ changes: [] });
    }),
  );
}

async function ask(question: string): Promise<HTMLElement> {
  render(<TryItPane assistant={ASSISTANT} />);
  fireEvent.change(screen.getByLabelText("Ask a question"), { target: { value: question } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await screen.findByRole("button", { name: "Send" });
  return screen.getByRole("log");
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Try it: links in the answer text", () => {
  it("shows a source linked in the text as a link, with no list of sources sent", async () => {
    // What the engine sends with the default settings (sources linked in the
    // text, no list under the answer): the link in tokens, no citation event.
    stubDraftChat([
      "Open [the reset ",
      "page](https://site.example/docs/reset) and choose ",
      "**Reset**.",
    ]);
    const log = await ask("How do I reset my password?");
    const link = await within(log).findByRole("link", { name: "the reset page" });
    expect(link.getAttribute("href")).toBe("https://site.example/docs/reset");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noreferrer");
    expect(log.textContent).not.toContain("](");
    expect(log.textContent).toContain("Open the reset page and choose **Reset**.");
    expect(log.querySelector(".turn-citations")).toBeNull();
  });

  it("keeps a code example literal and still links the source in the prose", async () => {
    stubDraftChat([
      "See [the guide](https://site.example/docs/links). Write a link like ",
      "`[example](https://example.com)` or:\n\n```md\n[example](https://ex",
      "ample.com)\n```\n",
    ]);
    const log = await ask("How do I write a link?");
    const link = await within(log).findByRole("link", { name: "the guide" });
    expect(link.getAttribute("href")).toBe("https://site.example/docs/links");
    expect(within(log).getAllByRole("link")).toHaveLength(1);
    expect(log.textContent).toContain(
      "Write a link like `[example](https://example.com)` or:\n\n```md\n[example](https://example.com)\n```",
    );
  });

  it("does not turn the owner's own question into links", async () => {
    stubDraftChat(["Sure."]);
    const log = await ask("What is [this](https://site.example/x)?");
    await within(log).findByText("Sure.");
    expect(within(log).queryByRole("link")).toBeNull();
    expect(log.textContent).toContain("What is [this](https://site.example/x)?");
  });
});

describe("InlineLinks", () => {
  function shown(text: string): HTMLElement {
    const { container } = render(
      <div>
        <InlineLinks text={text} />
      </div>,
    );
    return container.firstElementChild as HTMLElement;
  }

  it("links every http(s) link and keeps the text around them", () => {
    const el = shown("See [one](https://a.example/1) and [two](http://b.example/2%28x%29).");
    const links = within(el).getAllByRole("link");
    expect(links.map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["one", "https://a.example/1"],
      ["two", "http://b.example/2%28x%29"],
    ]);
    expect(el.textContent).toBe("See one and two.");
  });

  it("leaves other addresses, escaped brackets, images and markup as plain text", () => {
    const text = [
      "[run](javascript:alert(1))",
      "[data](data:text/html,x)",
      "[rel](/docs/reset)",
      "\\[escaped](https://a.example/e)",
      "![image](https://a.example/i.png)",
      "[](https://a.example/empty)",
      "<img src=x onerror=alert(1)>",
    ].join(" ");
    const el = shown(text);
    expect(within(el).queryByRole("link")).toBeNull();
    expect(el.querySelector("img")).toBeNull();
    expect(el.textContent).toBe(text);
  });

  it("links a link after an escaped backslash", () => {
    const el = shown("a \\\\[b](https://a.example/b)");
    expect(within(el).getByRole("link", { name: "b" }).getAttribute("href")).toBe(
      "https://a.example/b",
    );
    expect(el.textContent).toBe("a \\\\b");
  });

  it("leaves links in code as written and links the prose around them", () => {
    const code = [
      "Inline `[a](https://a.example/a)` and ``[b](https://a.example/b) ` here``.",
      "```\n[c](https://a.example/c)\n```",
      "~~~~md\n[d](https://a.example/d)\n```\n[e](https://a.example/e)\n~~~~",
      "    [f](https://a.example/f)",
      "- A step:\n\n  ```\n  [g](https://a.example/g)\n  ```",
      "> ```\n> [h](https://a.example/h)\n> ```",
      "Unclosed `[i](https://a.example/i)",
    ];
    for (const text of code) {
      const el = shown(text);
      expect(within(el).queryByRole("link"), text).toBeNull();
      expect(el.textContent).toBe(text);
    }
  });

  it("links prose next to code, after a closed fence and with Windows line endings", () => {
    const text = [
      "Use `x` with [one](https://a.example/1).",
      "```\r\n[code](https://a.example/c)\r\n```",
      "Then [two](https://a.example/2) and `[not](https://a.example/n)`.",
      "[a `flag` here](https://a.example/3)",
    ].join("\r\n\r\n");
    const el = shown(text);
    expect(
      within(el)
        .getAllByRole("link")
        .map((a) => a.getAttribute("href")),
    ).toEqual(["https://a.example/1", "https://a.example/2", "https://a.example/3"]);
    expect(el.textContent).toContain("```\r\n[code](https://a.example/c)\r\n```");
    expect(el.textContent).toContain("`[not](https://a.example/n)`");
    expect(within(el).getByRole("link", { name: "a `flag` here" })).toBeTruthy();
  });

  it("does not link a link whose address starts inside a code span", () => {
    const text = "[a`](https://a.example/a)`";
    const el = shown(text);
    expect(within(el).queryByRole("link")).toBeNull();
    expect(el.textContent).toBe(text);
  });
});
