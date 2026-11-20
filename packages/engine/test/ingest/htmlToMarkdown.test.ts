import { describe, expect, it } from "vitest";
import {
  extractHtml,
  LINK_BLOCK_MAX_OUTSIDE_SHARE,
  LINK_BLOCK_MIN_LINKS,
} from "../../src/ingest/htmlToMarkdown.js";

const URL_ = "https://docs.example.com/guide";

/** A docs page as a static site generator writes one: chrome around a `main`. */
const DOCS_PAGE = `<!doctype html><html><head><title>Test your MCP server online</title></head>
<body>
<header class="site"><a href="/">mcptest</a><nav><ul>
  <li><a href="/docs">Docs</a></li><li><a href="/pricing">Pricing</a></li></ul></nav></header>
<div role="navigation" class="breadcrumbs"><a href="/">Home</a> / <a href="/guides">Guides</a></div>
<main>
  <article>
    <header><h1>Test your MCP server online</h1><p>Updated 3 November</p></header>
    <p>Paste the address of your server and press <a href="/connect">Connect</a>. The tester lists its tools.</p>
    <h2>Steps</h2>
    <ol>
      <li>Open the tester and paste your server's URL.</li>
      <li>Choose the transport. Remote servers use <a href="/http">Streamable HTTP</a>.</li>
      <li>Press Connect, then call a tool from the list.</li>
    </ol>
    <h2>Related guides</h2>
    <ul>
      <li><a href="/what-is-mcp">What is MCP?</a></li>
      <li><a href="/remote-vs-local">Remote vs Local</a></li>
      <li><a href="/glossary">MCP Glossary</a></li>
    </ul>
    <div class="cards"><a href="/a">Public MCP test servers</a> · <a href="/b">MCP Inspector alternatives</a></div>
  </article>
  <aside><h3>On this page</h3><a href="#steps">Steps</a></aside>
</main>
<footer><h3>Guides</h3><ul><li><a href="/x">What is MCP?</a></li><li><a href="/y">Remote vs Local</a></li></ul>
<p>© 2026 mcptest</p></footer>
<div role="contentinfo">Made with care</div>
</body></html>`;

describe("extractHtml: page chrome", () => {
  it("keeps the main content and leaves out navigation, header, footer, aside and link lists", () => {
    const { title, markdown } = extractHtml(DOCS_PAGE, URL_);
    expect(title).toBe("Test your MCP server online");
    expect(markdown).toBe(
      [
        "# Test your MCP server online",
        "Updated 3 November",
        "Paste the address of your server and press Connect. The tester lists its tools.",
        "## Steps",
        "- Open the tester and paste your server's URL.\n- Choose the transport. Remote servers use Streamable HTTP.\n- Press Connect, then call a tool from the list.",
        "## Related guides",
      ].join("\n\n"),
    );
    for (const chrome of [
      "Pricing",
      "Home",
      "On this page",
      "© 2026",
      "Made with care",
      "Glossary",
    ]) {
      expect(markdown).not.toContain(chrome);
    }
  });

  it("drops landmarks by element and by role on a page without main or article", () => {
    const html = `<body>
      <header><p>Site banner text</p></header>
      <nav><p>Menu text</p></nav>
      <div role="banner">Role banner</div>
      <div role="complementary"><p>Side note</p></div>
      <section role="search"><p>Search the docs</p></section>
      <h1>Opening hours</h1>
      <p>We are open Tuesday to Saturday.</p>
      <aside>Ad</aside>
      <footer>Footer text</footer>
      <div role="contentinfo">Legal text</div>
    </body>`;
    expect(extractHtml(html, URL_).markdown).toBe(
      "# Opening hours\n\nWe are open Tuesday to Saturday.",
    );
  });

  it("keeps an article's own header, but drops the site header outside it", () => {
    const html = `<header>Site</header><section><header><h2>Section title</h2></header><p>Body.</p></section>`;
    expect(extractHtml(html, URL_).markdown).toBe("## Section title\n\nBody.");
  });

  it("keeps an aside inside an article, with the requirement it states", () => {
    const html = `<main><article><h1>Remote setup</h1><p>Connect using HTTPS.</p><aside><h2>Authentication requirement</h2><p>You must supply an Authorization header when connecting to a private server.</p></aside></article></main>`;
    expect(extractHtml(html, URL_).markdown).toBe(
      [
        "# Remote setup",
        "Connect using HTTPS.",
        "## Authentication requirement",
        "You must supply an Authorization header when connecting to a private server.",
      ].join("\n\n"),
    );
  });

  it("keeps a named aside in a section, and still drops the sidebar beside it", () => {
    const html = `<body><aside><h3>Guides</h3><p>Sidebar blurb.</p></aside>
      <main><aside><p>On this page</p></aside>
        <section><h2>Limits</h2><p>Requests are rate limited.</p>
          <aside aria-label="Note"><p>Each key allows 60 requests a minute.</p></aside>
          <aside role="complementary"><p>Sponsored.</p></aside>
        </section>
      </main></body>`;
    expect(extractHtml(html, URL_).markdown).toBe(
      "## Limits\n\nRequests are rate limited.\n\nEach key allows 60 requests a minute.",
    );
  });

  it("judges an aside with a role of its own by that role", () => {
    const html = `<main><p>Body.</p><aside role="note"><p>Keep this note.</p></aside>
      <aside role="navigation"><p>Menu.</p></aside><aside role=""><p>Sidebar.</p></aside></main>`;
    expect(extractHtml(html, URL_).markdown).toBe("Body.\n\nKeep this note.");
  });

  it("handles nested chrome of the same element and role", () => {
    const html = `<div role="navigation"><div><div>Deep menu</div></div><div>More menu</div></div>
      <div><p>Real text.</p></div>`;
    expect(extractHtml(html, URL_).markdown).toBe("Real text.");
  });

  it("uses the only article when there is no main, and the whole page with several", () => {
    expect(extractHtml(`<p>Teaser</p><article><p>The post.</p></article>`, URL_).markdown).toBe(
      "The post.",
    );
    expect(
      extractHtml(`<article><p>One.</p></article><article><p>Two.</p></article>`, URL_).markdown,
    ).toBe("One.\n\nTwo.");
  });

  it("does not take an article inside chrome for the page's content", () => {
    const html = `<h1>Setup</h1><p>Install the CLI and run it.</p>
      <aside><article><p>Related post preview.</p></article></aside>`;
    expect(extractHtml(html, URL_).markdown).toBe("# Setup\n\nInstall the CLI and run it.");
  });

  it("uses the real article when another one sits inside chrome", () => {
    const html = `<nav><article><p>Menu card.</p></article></nav>
      <article><p>The post.</p></article><p>Outside.</p>`;
    expect(extractHtml(html, URL_).markdown).toBe("The post.");
  });

  it("skips a main inside a template or role chrome and uses the real main", () => {
    const html = `<template><main><p>Template text.</p></main></template>
      <div role="complementary"><div role="main"><p>Sidebar text.</p></div></div>
      <main><p>Real text.</p></main><p>Outside.</p>`;
    expect(extractHtml(html, URL_).markdown).toBe("Real text.");
  });

  it('keeps the header inside a role="main" region', () => {
    const html = `<header>Site</header><div role="main"><header><h1>Title</h1></header><p>Body.</p></div>`;
    expect(extractHtml(html, URL_).markdown).toBe("# Title\n\nBody.");
  });

  it("falls back to the whole page when main holds no text", () => {
    expect(extractHtml(`<main><div id="app"></div></main><p>Server text.</p>`, URL_).markdown).toBe(
      "Server text.",
    );
  });

  it("keeps the rest of the page when a chrome element is never closed", () => {
    expect(extractHtml(`<nav><p>Menu</p><p>Real text.</p>`, URL_).markdown).toContain("Real text.");
  });
});

describe("extractHtml: link lists", () => {
  it("states its rule", () => {
    expect(LINK_BLOCK_MIN_LINKS).toBe(2);
    expect(LINK_BLOCK_MAX_OUTSIDE_SHARE).toBe(0.1);
  });

  it("drops a list that is only links, with blurbs inside the links too", () => {
    const html = `<h2>Related guides</h2><ul>
      <li><a href="/a"><strong>Public MCP test servers</strong><span>Servers you can point a client at.</span></a></li>
      <li><a href="/b"><strong>MCP Inspector alternatives</strong><span>Other tools that do the same.</span></a></li>
    </ul><p>Real text after.</p>`;
    expect(extractHtml(html, URL_).markdown).toBe("## Related guides\n\nReal text after.");
  });

  it("keeps a real list whose items say something besides their link", () => {
    const html = `<ul>
      <li>Install the CLI with npm, then read the <a href="/setup">setup guide</a>.</li>
      <li>Set your key in <a href="/settings">Settings</a> before the first push.</li>
    </ul>`;
    expect(extractHtml(html, URL_).markdown).toBe(
      "- Install the CLI with npm, then read the setup guide.\n- Set your key in Settings before the first push.",
    );
  });

  it("keeps prose with links, a paragraph that is one link, and a heading that is a link", () => {
    const html = `<h2><a href="#email">Email</a></h2><p><a href="mailto:hi@example.com">hi@example.com</a></p>
      <p>Read <a href="/a">the guide</a> and <a href="/b">the reference</a> before you start.</p>`;
    expect(extractHtml(html, URL_).markdown).toBe(
      "## Email\n\nhi@example.com\n\nRead the guide and the reference before you start.",
    );
  });

  it("drops a paragraph of links joined by separators", () => {
    const html = `<p><a href="/a">Docs</a> | <a href="/b">Blog</a> | <a href="/c">Status</a></p><p>Body.</p>`;
    expect(extractHtml(html, URL_).markdown).toBe("Body.");
  });

  it("leaves no link markers in the text, even ones the page itself held", () => {
    const html = `<p>Odd  characters  here and a <a href="/x">link</a>.</p>`;
    const { markdown } = extractHtml(html, URL_);
    expect(markdown).not.toMatch(/[]/);
    expect(markdown).toBe("Odd  characters  here and a link.");
  });
});
