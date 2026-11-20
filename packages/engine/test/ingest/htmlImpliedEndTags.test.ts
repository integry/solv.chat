import { describe, expect, it } from "vitest";
import { closeImpliedEndTags, extractHtml } from "../../src/ingest/htmlToMarkdown.js";

// Issue #128: HTML lets a page leave out some end tags (HTML Standard,
// 13.1.2.4 "Optional tags"). Each rule is checked by converting a page that
// leaves the tags out and the same page with them written in: the two must
// give the same text.

const URL_ = "https://docs.example.com/guide";

const md = (html: string) => extractHtml(html, URL_).markdown;

describe("closeImpliedEndTags: the rules", () => {
  it.each([
    [
      "li at the next li and at the parent's end",
      "<ul><li>One<li>Two</ul>",
      "<ul><li>One</li><li>Two</li></ul>",
    ],
    [
      "dt and dd at each other",
      "<dl><dt>Term<dd>Meaning<dt>Next<dd>More</dl>",
      "<dl><dt>Term</dt><dd>Meaning</dd><dt>Next</dt><dd>More</dd></dl>",
    ],
    ["p at the next p", "<p>One<p>Two", "<p>One</p><p>Two</p>"],
    [
      "p at a block element",
      "<p>Intro<ul><li>Item</li></ul>",
      "<p>Intro</p><ul><li>Item</li></ul>",
    ],
    ["p at a heading", "<p>Intro<h2>Next</h2>", "<p>Intro</p><h2>Next</h2>"],
    ["p at its parent's end", "<div><p>Text</div>", "<div><p>Text</p></div>"],
    [
      "td and th at each other, tr at the next tr",
      "<table><tr><th>A<th>B<tr><td>1<td>2</table>",
      "<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>",
    ],
    [
      "thead and tbody at the next section, tfoot at the parent's end",
      "<table><thead><tr><th>H<tbody><tr><td>B<tfoot><tr><td>F</table>",
      "<table><thead><tr><th>H</th></tr></thead><tbody><tr><td>B</td></tr></tbody><tfoot><tr><td>F</td></tr></tfoot></table>",
    ],
    [
      "option at option, optgroup and hr; optgroup at optgroup and hr",
      "<select><optgroup label=a><option>1<option>2<optgroup label=b><option>3<hr><option>4</select>",
      "<select><optgroup label=a><option>1</option><option>2</option></optgroup><optgroup label=b><option>3</option></optgroup><hr><option>4</option></select>",
    ],
    [
      "rt and rp at each other",
      "<ruby>漢<rp>(<rt>kan<rp>)</ruby>",
      "<ruby>漢<rp>(</rp><rt>kan</rt><rp>)</rp></ruby>",
    ],
    ["what is still open at the end of the page", "<ul><li>Last", "<ul><li>Last</li>"],
  ])("ends %s", (_rule, omitted, closed) => {
    expect(closeImpliedEndTags(omitted)).toBe(closed);
  });

  it("ends an open paragraph inside an item before the next item", () => {
    expect(closeImpliedEndTags("<ul><li><p>One<li>Two</ul>")).toBe(
      "<ul><li><p>One</p></li><li>Two</li></ul>",
    );
  });

  it("does not end an item at an item of a nested list", () => {
    expect(closeImpliedEndTags("<ul><li>A<ul><li>A1<li>A2</ul><li>B</ul>")).toBe(
      "<ul><li>A<ul><li>A1</li><li>A2</li></ul></li><li>B</li></ul>",
    );
  });

  it("does not end an element at a tag the standard does not name", () => {
    // A span does not end a paragraph, and an li does not end a p that is
    // not inside it; an end tag with nothing of its name open is kept.
    expect(closeImpliedEndTags("<p>One <span>two</span> three</p></li>")).toBe(
      "<p>One <span>two</span> three</p></li>",
    );
  });
});

describe("extractHtml: pages that leave out end tags", () => {
  it("converts nested lists without </li> as it does with them", () => {
    const omitted = `<h2>Steps</h2><ul><li>Install the CLI<ul><li>with npm<li>or with brew</ul><li>Log in</ul><p>Then push.`;
    const closed = `<h2>Steps</h2><ul><li>Install the CLI<ul><li>with npm</li><li>or with brew</li></ul></li><li>Log in</li></ul><p>Then push.</p>`;
    expect(md(omitted)).toBe(md(closed));
    expect(md(omitted)).toContain("- Log in");
    expect(md(omitted)).toMatch(/\n\nThen push\.$/);
  });

  it("ends a paragraph at a block element", () => {
    const html = `<p>First paragraph<div>A block of its own</div><p>Second paragraph<h2>Next</h2><p>Last`;
    expect(md(html)).toBe(
      "First paragraph\n\nA block of its own\n\nSecond paragraph\n\n## Next\n\nLast",
    );
  });

  it("converts a table without </td> and </tr> as it does with them", () => {
    const omitted = `<table><tr><th>Plan<th>Price<tr><td>Free<td>0<tr><td>Pro<td>10</table><p>After the table.</p>`;
    const closed = `<table><tr><th>Plan</th><th>Price</th></tr><tr><td>Free</td><td>0</td></tr><tr><td>Pro</td><td>10</td></tr></table><p>After the table.</p>`;
    expect(md(omitted)).toBe(md(closed));
    // Cells run together and a table is not a block of its own, as before
    // #128; what matters here is that each row ends where it ends.
    expect(md(omitted)).toBe("PlanPrice\nFree0\nPro10\nAfter the table.");
  });

  it("keeps the items of a list without </li> after it", () => {
    const html = `<dl><dt>Plan<dd>What you pay for<dt>Seat<dd>One person</dl><h2>Billing</h2><p>Paid monthly.</p>`;
    expect(md(html)).toMatch(/\n\n## Billing\n\nPaid monthly\.$/);
  });

  // The shape of https://sqlite.org/whentouse.html (issue #128), reduced: a
  // menu of items with no </li>, then the page's title, its sections and
  // paragraphs, some of them without </p> either.
  const WHENTOUSE_SHAPE = `<!DOCTYPE html><html><head><title>Appropriate Uses For SQLite</title></head>
<body>
<div class=nosearch>
<a href="index.html"><img class="logo" src="logo.svg" alt="SQLite"></a>
<div class="menu mainmenu">
<ul>
<li><a href="index.html">Home</a>
<li class='mobileonly'><a href="javascript:void(0)">Menu</a>
<li class='wideonly'><a href='about.html'>About</a>
<li class='desktoponly'><a href="docs.html">Documentation</a>
<li class='desktoponly'><a href="download.html">Download</a>
<li class='search'>
<a href="javascript:void(0)">Search</a>
</ul>
</div>
</div>
<div class=fancy>
<h1>Appropriate Uses For SQLite</h1>
<p>SQLite is not directly comparable to client/server SQL database engines.
<p>SQLite strives to provide local data storage for individual applications.
<h2>Situations Where SQLite Works Well</h2>
<ul>
<li><p><b>Embedded devices</b></p>
<p>SQLite needs no administration, so it works well in devices without expert support.
<li><p><b>Websites</b></p>
<p>SQLite works great as the database engine for most low to medium traffic websites.
</ul>
<h2>Situations Where A Client/Server RDBMS May Work Better</h2>
<p>A client/server database suits data that many computers reach over a network.
</div>
</body></html>`;

  it("drops the whentouse menu as a link list and keeps the page's structure", () => {
    const markdown = md(WHENTOUSE_SHAPE);
    expect(markdown).toBe(
      [
        "# Appropriate Uses For SQLite",
        "SQLite is not directly comparable to client/server SQL database engines.",
        "SQLite strives to provide local data storage for individual applications.",
        "## Situations Where SQLite Works Well",
        "- Embedded devices SQLite needs no administration, so it works well in devices without expert support.\n- Websites SQLite works great as the database engine for most low to medium traffic websites.",
        "## Situations Where A Client/Server RDBMS May Work Better",
        "A client/server database suits data that many computers reach over a network.",
      ].join("\n\n"),
    );
    for (const menu of ["Home", "Documentation", "Download", "Search"]) {
      expect(markdown).not.toContain(menu);
    }
  });
});

describe("extractHtml: pages that close their elements", () => {
  // Well-formed pages of the kinds the other converter tests use. They must
  // come back from `closeImpliedEndTags` byte for byte, so they convert
  // exactly as before issue #128.
  const WELL_FORMED = [
    `<!doctype html><html><head><title>Guide</title></head><body>
<header class="site"><a href="/">mcptest</a><nav><ul>
  <li><a href="/docs">Docs</a></li><li><a href="/pricing">Pricing</a></li></ul></nav></header>
<main><article>
  <header><h1>Test your MCP server online</h1><p>Updated 3 November</p></header>
  <p>Paste the address of your server and press <a href="/connect">Connect</a>.</p>
  <h2>Steps</h2>
  <ol>
    <li>Open the tester.</li>
    <li>Choose the transport. Remote servers use <a href="/http">Streamable HTTP</a>.</li>
  </ol>
  <aside><p>Note: a token is needed.</p></aside>
</article></main>
<footer><ul><li><a href="/x">What is MCP?</a></li></ul><p>© 2026</p></footer>
</body></html>`,
    `<table><thead><tr><th>Plan</th><th>Price</th></tr></thead><tbody><tr><td>Free</td><td>0</td></tr></tbody></table>`,
    `<dl><dt>Term</dt><dd>Meaning<br>more</dd></dl><select><option>One</option></select><img src="a.png" /><hr>`,
    `<ul><li>A<ul><li>A1</li></ul></li></ul><p>Odd <b>bold <i>both</i></b> text.</p><!-- a comment -->`,
  ];

  it.each(WELL_FORMED.map((html, i) => [i, html]))("leaves fixture %i unchanged", (_i, html) => {
    expect(closeImpliedEndTags(html)).toBe(html);
  });

  it("converts the docs page as before", () => {
    expect(md(WELL_FORMED[0] as string)).toBe(
      [
        "# Test your MCP server online",
        "Updated 3 November",
        "Paste the address of your server and press Connect.",
        "## Steps",
        "- Open the tester.\n- Choose the transport. Remote servers use Streamable HTTP.",
        "Note: a token is needed.",
      ].join("\n\n"),
    );
  });
});
