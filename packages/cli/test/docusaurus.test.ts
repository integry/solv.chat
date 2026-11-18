import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  cleanDocusaurusMarkdown,
  docusaurusSlug,
  hasDocusaurusFrontMatter,
  hasDocusaurusSyntax,
  stripNumberPrefix,
  withDescription,
} from "../src/docusaurus.js";
import { extraFileId, type PushOptions, push } from "../src/push.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const site = join(fixtures, "docusaurus-site");

interface Sent {
  method: string;
  body: Record<string, unknown>;
}

async function run(options: Omit<PushOptions, "endpoint" | "assistant" | "ingestKey">) {
  const sent: Sent[] = [];
  const logs: string[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    sent.push({ method: init?.method ?? "GET", body });
    const docs = Array.isArray(body.documents) ? body.documents : [];
    return Response.json({ written: docs.length, unchanged: 0, deleted: 0 });
  };
  await push(
    { endpoint: "https://chat.example.com", assistant: "ast_1", ingestKey: "ik_test", ...options },
    { fetchImpl, log: (line) => logs.push(line) },
  );
  const documents = sent
    .filter((req) => req.method === "PUT")
    .flatMap((req) => req.body.documents as Record<string, unknown>[]);
  return { sent, logs, documents };
}

describe("solv push on a Docusaurus docs folder", () => {
  it("maps URLs, titles and content by Docusaurus rules", async () => {
    const readme = join(site, "README.md");
    const changelog = join(site, "CHANGELOG.md");
    const { documents, logs, sent } = await run({
      dir: join(site, "docs"),
      baseUrl: "https://acme.dev/docs",
      exclude: ["**/_*", "drafts/**"],
      files: [
        { path: readme, url: "https://acme.dev/" },
        { path: changelog, url: "https://acme.dev/changelog" },
      ],
      source: "docs",
      prune: true,
    });

    expect(logs[0]).toBe("Docusaurus content found: using its URLs, titles and cleanup");
    expect(documents).toEqual([
      {
        // A file named like its folder is the folder's page; prefixes go.
        externalId: "01-getting-started/01-getting-started",
        title: "Getting started",
        url: "https://acme.dev/docs/getting-started/",
        markdown: "This section gets you running.\n",
      },
      {
        // .mdx is pushed; sidebar_label names it when there is no title.
        externalId: "01-getting-started/02-installation",
        title: "Install Acme",
        url: "https://acme.dev/docs/getting-started/installation",
        markdown: [
          "# Installation",
          "",
          "Install it with your package manager.",
          "",
          "```bash",
          "npm install acme",
          "```",
          "",
          "```bash",
          "yarn add acme",
          "```",
          "",
          "**Pro tip:** Pin the version in CI.",
          "",
          '<img src="/img/diagram.png" alt="How it fits" />',
          "",
          '```mdx title="example.mdx"',
          "import Tabs from '@theme/Tabs';",
          "",
          ":::note",
          "Kept exactly.",
          ":::",
          "",
          '<Tabs>  <TabItem value="a">A</TabItem></Tabs>',
          "```",
          "",
          "Use `<Tabs>` to group options.",
          "",
        ].join("\n"),
      },
      {
        // Front matter id replaces the file name in the URL.
        externalId: "01-getting-started/03-configure",
        title: "Configure Acme",
        url: "https://acme.dev/docs/getting-started/configuration",
        markdown: [
          "**Back up first:** Configuration changes take effect at once.",
          "",
          "**Info:** Settings live in `acme.json`.",
          "",
          "**Danger:** Never commit your key.",
          "",
          "**Note:**",
          "",
          "- one",
          "- two",
          "",
        ].join("\n"),
      },
      {
        externalId: "api/README",
        title: "API",
        url: "https://acme.dev/docs/api/",
        markdown: "# API\n\nThe API reference.\n",
      },
      {
        // A date is not a number prefix.
        externalId: "guides/2024-01-release",
        title: "January release",
        url: "https://acme.dev/docs/guides/2024-01-release",
        markdown: "# January release\n\nDates are not number prefixes.\n",
      },
      {
        // A relative slug resolves against the doc's folder.
        externalId: "guides/deploy",
        title: "Deploying",
        url: "https://acme.dev/docs/guides/ship-it",
        markdown: "# Deploying\n\nShip it.\n",
      },
      {
        externalId: "guides/index",
        title: "Guides",
        url: "https://acme.dev/docs/guides/",
        markdown: "# Guides\n\nPick a guide.\n",
      },
      {
        // `slug: /` is the docs root; description leads the body.
        externalId: "intro",
        title: "Welcome to Acme",
        url: "https://acme.dev/docs/",
        markdown: "# Welcome\n\nStart here to learn what Acme does.\n\nAcme sends your messages.\n",
      },
      {
        // Plain files outside the folder keep their content as written.
        externalId: extraFileId(readme),
        title: "Acme SDK",
        url: "https://acme.dev/",
        markdown: await readFile(readme, "utf8"),
      },
      {
        externalId: extraFileId(changelog),
        title: "Changelog",
        url: "https://acme.dev/changelog",
        markdown: await readFile(changelog, "utf8"),
      },
    ]);

    // Every PUT and the prune name the source; prune keeps exactly what was pushed.
    expect(sent.every((req) => req.body.source === "docs")).toBe(true);
    const prune = sent.at(-1);
    expect(prune?.method).toBe("DELETE");
    expect(prune?.body).toEqual({
      source: "docs",
      prune: true,
      keep: documents.map((doc) => doc.externalId),
    });
  });

  it("selects files with repeatable --include and --exclude globs", async () => {
    const { documents } = await run({
      dir: join(site, "docs"),
      baseUrl: "https://acme.dev/docs",
      include: ["guides/**", "*.md", "01-*/0[23]-*.{md,mdx}"],
      exclude: ["**/index.md", "**/*.mdx"],
    });
    expect(documents.map((doc) => doc.externalId)).toEqual([
      "01-getting-started/03-configure",
      "guides/2024-01-release",
      "guides/deploy",
      "intro",
    ]);
  });

  it("decides Docusaurus for the whole folder, whatever --include selects", async () => {
    // Neither selected page has a Docusaurus signal of its own (a `slug` alone
    // is not one); the rest of the folder does, so their URLs do not change
    // with the selection.
    const { documents } = await run({
      dir: join(site, "docs"),
      baseUrl: "https://acme.dev/docs/",
      include: ["guides/index.md", "guides/deploy.md"],
    });
    expect(documents.map((doc) => doc.url)).toEqual([
      "https://acme.dev/docs/guides/ship-it",
      "https://acme.dev/docs/guides/",
    ]);
  });

  it("applies Docusaurus rules to every page when one page has a Docusaurus signal", async () => {
    const root = await mkdtemp(join(tmpdir(), "solv-docusaurus-"));
    try {
      await mkdir(join(root, "02-guides"));
      await writeFile(join(root, "01-intro.md"), "---\nsidebar_position: 1\n---\n# Intro\n");
      await writeFile(join(root, "02-guides", "index.md"), "# Guides\n");
      const { documents } = await run({ dir: root, baseUrl: "https://acme.dev" });
      expect(documents.map((doc) => [doc.externalId, doc.url])).toEqual([
        ["01-intro", "https://acme.dev/intro"],
        ["02-guides/index", "https://acme.dev/guides/"],
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prints the source on a dry run and sends nothing", async () => {
    const { sent, logs } = await run({
      dir: join(site, "docs"),
      baseUrl: "https://acme.dev/docs",
      include: ["guides/*.md"],
      source: "docs",
      prune: true,
      dryRun: true,
    });
    expect(sent).toEqual([]);
    expect(logs).toEqual([
      "Docusaurus content found: using its URLs, titles and cleanup",
      "3 documents would be pushed",
      "  guides/2024-01-release -> https://acme.dev/docs/guides/2024-01-release",
      "  guides/deploy -> https://acme.dev/docs/guides/ship-it",
      "  guides/index -> https://acme.dev/docs/guides/",
      'Would prune documents of source "docs" not in the 3-document pushed set',
    ]);
  });
});

describe("solv push on a plain Markdown folder", () => {
  it("keeps paths, titles and content exactly as before", async () => {
    const root = join(fixtures, "plain-folder");
    const { documents, logs, sent } = await run({
      dir: root,
      baseUrl: "https://example.com",
      prune: true,
    });
    expect(logs[0]).toBe("Pushed 3 documents (3 written, 0 unchanged)");
    const body = async (rel: string) =>
      (await readFile(join(root, rel), "utf8")).replace(/^---\n[\s\S]*?\n---\n/, "");
    expect(documents).toEqual([
      {
        externalId: "index",
        title: "Home",
        url: "https://example.com/index",
        markdown: await body("index.md"),
      },
      {
        externalId: "notes/01-first",
        title: "First note",
        url: "https://example.com/notes/01-first",
        markdown: await body("notes/01-first.md"),
      },
      {
        externalId: "notes/README",
        title: "notes/README",
        url: "https://example.com/notes/README",
        markdown: await body("notes/README.md"),
      },
    ]);
    // No source named: the bodies are exactly what they were before --source.
    expect(sent.map((req) => Object.keys(req.body))).toEqual([["documents"], ["prune", "keep"]]);
  });
});

describe("Docusaurus rules", () => {
  it("strips number prefixes the way Docusaurus does", () => {
    expect(stripNumberPrefix("01-intro")).toBe("intro");
    expect(stripNumberPrefix("003 - Guide")).toBe("Guide");
    expect(stripNumberPrefix("2_setup")).toBe("setup");
    expect(stripNumberPrefix("10.advanced")).toBe("advanced");
    expect(stripNumberPrefix("2024-01-release")).toBe("2024-01-release");
    expect(stripNumberPrefix("7.0-notes")).toBe("7.0-notes");
    expect(stripNumberPrefix("404")).toBe("404");
    expect(stripNumberPrefix("1-")).toBe("1-");
  });

  it("computes slugs from paths, id, slug and index files", () => {
    expect(docusaurusSlug("intro", {})).toBe("/intro");
    expect(docusaurusSlug("01-a/02-b/03-c", {})).toBe("/a/b/c");
    expect(docusaurusSlug("index", {})).toBe("/");
    expect(docusaurusSlug("Guides/INDEX", {})).toBe("/Guides/");
    expect(docusaurusSlug("Guides/readme", {})).toBe("/Guides/");
    expect(docusaurusSlug("Guides/Guides", {})).toBe("/Guides/");
    expect(docusaurusSlug("02-tools/02-tools", {})).toBe("/tools/");
    expect(docusaurusSlug("a/b", { id: "custom" })).toBe("/a/custom");
    expect(docusaurusSlug("a/index", { id: "custom" })).toBe("/a/");
    expect(docusaurusSlug("a/b", { slug: "/abs/path" })).toBe("/abs/path");
    expect(docusaurusSlug("a/index", { slug: "/" })).toBe("/");
    expect(docusaurusSlug("a/b", { slug: "rel" })).toBe("/a/rel");
    expect(docusaurusSlug("a/b/c", { slug: "../up" })).toBe("/a/up");
    expect(docusaurusSlug("a/b", { slug: "./same/" })).toBe("/a/same/");
    expect(docusaurusSlug("a/b", { slug: "rel", id: "ignored" })).toBe("/a/rel");
  });

  it("detects Docusaurus from front matter keys and syntax outside code only", () => {
    expect(hasDocusaurusFrontMatter("sidebar_position: 2")).toBe(true);
    expect(hasDocusaurusFrontMatter("title: Hi\nhide_title: true")).toBe(true);
    expect(hasDocusaurusFrontMatter("title: Hi\nslug: /x\nid: y\ndescription: z")).toBe(false);
    expect(hasDocusaurusFrontMatter("  sidebar_label: nested")).toBe(false);
    expect(hasDocusaurusFrontMatter(null)).toBe(false);
    expect(hasDocusaurusSyntax(":::tip\nHi\n:::\n")).toBe(true);
    expect(hasDocusaurusSyntax("import Tabs from '@theme/Tabs';\n")).toBe(true);
    expect(hasDocusaurusSyntax("```\n:::tip\nimport X from '@theme/X';\n```\n")).toBe(false);
    expect(hasDocusaurusSyntax("::: tip\n:::custom\nimport x from 'y'\n")).toBe(false);
  });

  it("converts every admonition type, with and without titles", () => {
    const input = [
      ":::note",
      "A note.",
      ":::",
      "",
      ":::tip[Quick tip]",
      "A tip.",
      ":::",
      "",
      ":::info Legacy title",
      "",
      "Info.",
      "",
      ":::",
      "",
      ":::warning[Careful!]",
      "Warned.",
      ":::",
      "",
      ":::danger",
      "```sh",
      "rm -rf /",
      "```",
      ":::",
      "",
      ":::",
      "A stray closing line stays.",
    ].join("\n");
    expect(cleanDocusaurusMarkdown(input)).toBe(
      [
        "**Note:** A note.",
        "",
        "**Quick tip:** A tip.",
        "",
        "**Legacy title:** Info.",
        "",
        "**Careful!** Warned.",
        "",
        "**Danger:**",
        "",
        "```sh",
        "rm -rf /",
        "```",
        "",
        ":::",
        "A stray closing line stays.",
        "",
      ].join("\n"),
    );
  });

  it("drops import/export blocks and JSX tags but keeps code byte for byte", () => {
    const code =
      "```tsx\r\n  <Button onClick={() => go()}>Go</Button>\r\n\r\n\r\nimport x from 'y';\r\n```";
    const input = [
      "import {",
      "  A,",
      "  B,",
      "} from './parts';",
      "export const meta = { a: 1 };",
      "",
      "Text with <Badge color=\"a > b\" n={1 > 0}>inline</Badge> and <Icon name='x' /> gone.",
      "",
      "<Card",
      '  title="Multi-line"',
      "  href={`/x`}",
      ">",
      "Card body.",
      "</Card>",
      "",
      "<>Fragment text</>",
      "",
      "<details><summary>HTML stays</summary>Body</details>",
      "",
      code,
      "",
      "Exporting data is easy. import is a word here.",
    ].join("\n");
    const out = cleanDocusaurusMarkdown(input);
    expect(out).toBe(
      [
        "Text with inline and  gone.",
        "",
        "Card body.",
        "",
        "Fragment text",
        "",
        "<details><summary>HTML stays</summary>Body</details>",
        "",
        code,
        "",
        "Exporting data is easy. import is a word here.",
        "",
      ].join("\n"),
    );
    expect(out).toContain(code);
  });

  it("keeps fenced code inside blockquotes byte for byte", () => {
    const quoted = ["> ~~~jsx", "> <Tabs>example</Tabs>", "> ~~~"].join("\n");
    const nested = ["> > ```", "> > <Tabs>", "> > ```"].join("\n");
    const input = [quoted, "", nested, "", "> After <Tabs>quote</Tabs>"].join("\n");
    expect(cleanDocusaurusMarkdown(input)).toBe(
      [quoted, "", nested, "", "> After quote", ""].join("\n"),
    );
    // Admonitions and imports inside a quoted fence are code, not signals.
    expect(hasDocusaurusSyntax("> ```md\n> :::tip\n> ```\n")).toBe(false);
  });

  it("ends a quoted fence where its blockquote ends", () => {
    const input = ["> ```", "> <Tabs>code</Tabs>", "", "Text <Tabs>after</Tabs>"].join("\n");
    expect(cleanDocusaurusMarkdown(input)).toBe(
      ["> ```", "> <Tabs>code</Tabs>", "", "Text after", ""].join("\n"),
    );
  });

  it("closes a code span only on a backtick run of the same length", () => {
    const span = "`a `` <Tabs> b`";
    expect(cleanDocusaurusMarkdown(`Use ${span} and <Tabs>x</Tabs>.`)).toBe(`Use ${span} and x.\n`);
    const double = "``a ` <Tabs> ``` b``";
    expect(cleanDocusaurusMarkdown(`${double} <Badge>y</Badge>`)).toBe(`${double} y\n`);
    // A run with no matching closer is literal, and tags after it still go.
    expect(cleanDocusaurusMarkdown("A `` lone <Tabs>z</Tabs>")).toBe("A `` lone z\n");
  });

  it("puts the description after a leading heading, or first", () => {
    expect(withDescription("# T\n\nBody\n", "About it.")).toBe("# T\n\nAbout it.\n\nBody\n");
    expect(withDescription("Body\n", "About it.")).toBe("About it.\n\nBody\n");
    expect(withDescription("", "About it.")).toBe("About it.\n");
    expect(withDescription("Body\n", undefined)).toBe("Body\n");
  });

  it("gives --file documents a working-directory-relative id", () => {
    expect(extraFileId("README.md", "/repo")).toBe("README.md");
    expect(extraFileId("./docs/../CHANGELOG.md", "/repo")).toBe("CHANGELOG.md");
    expect(extraFileId("/repo/pkg/README.md", "/repo")).toBe("pkg/README.md");
  });
});
