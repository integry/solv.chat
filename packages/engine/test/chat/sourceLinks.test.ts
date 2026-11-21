import { describe, expect, it } from "vitest";
import {
  type LinkTargets,
  linkDestinations,
  linkTargets,
  pageKey,
  rewriteSourceLinks,
  sourceLinker,
} from "../../src/chat/sourceLinks.js";

const TESTING = "https://docs.example.com/guide/testing";
const PRICING = "https://docs.example.com/pricing";
const STATUS = "https://status.example.net/";

/** Source 1 the testing guide, 2 a written answer, 3 pricing (whose text names the status page). */
const TARGETS: LinkTargets = linkTargets([
  { url: TESTING, text: "Run vitest to test." },
  { url: "https://admin.example/sources/src_1/entries/doc_9", text: "Yes.", sourceKind: "entry" },
  { url: PRICING, text: `Plans start at $10. Outages: ${STATUS}.` },
]);

function rewrite(text: string, before = ""): string {
  return rewriteSourceLinks(text, TARGETS, before).text;
}

/** Streams `text` cut at `cuts` and returns every delta sent, the flush last. */
function stream(text: string, cuts: number[], before = ""): string[] {
  const linker = sourceLinker(TARGETS, before);
  const out: string[] = [];
  let at = 0;
  for (const cut of [...cuts, text.length]) {
    out.push(linker.push(text.slice(at, cut)));
    at = cut;
  }
  out.push(linker.flush());
  return out;
}

describe("chat/sourceLinks", () => {
  it("turns a numbered reference into a link to that source's page", () => {
    expect(rewrite("Read [the testing guide][1] first.")).toBe(
      `Read [the testing guide](${TESTING}) first.`,
    );
    // The same by number in parentheses, and with spaces in the brackets.
    expect(rewrite("See [pricing](3) and [the guide][ 1 ].")).toBe(
      `See [pricing](${PRICING}) and [the guide](${TESTING}).`,
    );
    const result = rewriteSourceLinks("[A][1] and [B][3].", TARGETS);
    expect(result.linked).toEqual([TESTING, PRICING]);
    expect(result.removed).toBe(0);
  });

  it("keeps a link's fragment in its destinations, not in the page it counts for", () => {
    const result = rewriteSourceLinks(
      `See [the steps](${TESTING}#steps), then [pricing][3] and <${STATUS}#now>.`,
      TARGETS,
    );
    expect(result.text).toBe(
      `See [the steps](${TESTING}#steps), then [pricing](${PRICING}) and <${STATUS}#now>.`,
    );
    expect(result.linked).toEqual([TESTING, PRICING, STATUS]);
    expect(result.destinations).toEqual([`${TESTING}#steps`, PRICING, `${STATUS}#now`]);
    // A second link to the page in the paragraph is still reduced, whatever its section.
    const again = rewriteSourceLinks(`[A](${TESTING}#a) and [B](${TESTING}#b).`, TARGETS);
    expect(again.text).toBe(`[A](${TESTING}#a) and B.`);
    expect(again.destinations).toEqual([`${TESTING}#a`]);
    // Streamed, the same destinations, and those written before a pause count.
    const linker = sourceLinker(TARGETS, `Earlier [x](${PRICING}#plans).\n\n`);
    linker.push(`Now [the steps](${TESTING}`);
    linker.push("#steps).");
    linker.flush();
    expect(linker.destinations).toEqual([`${PRICING}#plans`, `${TESTING}#steps`]);
  });

  it("gives a written answer no link, and reduces a reference to no source to its text", () => {
    const result = rewriteSourceLinks(
      "Yes, [refunds][2] are allowed, see [the docs][7] and [the guide][docs] or [it][].",
      TARGETS,
    );
    expect(result.text).toBe("Yes, refunds are allowed, see the docs and the guide or it.");
    expect(result.removed).toBe(4);
    expect(result.linked).toEqual([]);
  });

  it("keeps a link written out to a retrieved page, or to an address its text contains", () => {
    expect(rewrite(`See [pricing](${PRICING}) and [the status page](${STATUS}).`)).toBe(
      `See [pricing](${PRICING}) and [the status page](${STATUS}).`,
    );
    // A section of a retrieved page is that page.
    expect(rewrite(`See [plans](${PRICING}#plans).`)).toBe(`See [plans](${PRICING}#plans).`);
  });

  it("reduces a fabricated, off-site, relative or non-web link to its text", () => {
    const result = rewriteSourceLinks(
      [
        "Read [the API guide](https://docs.example.com/guide/api),",
        "[our partner](https://evil.example/phish),",
        "[pricing](/pricing), [email us](mailto:help@example.com)",
        "and [run it](javascript:alert(1)).",
      ].join(" "),
      TARGETS,
    );
    expect(result.text).toBe("Read the API guide, our partner, pricing, email us and run it.");
    expect(result.removed).toBe(5);
  });

  it("treats an image and an autolink like any link", () => {
    expect(rewrite("![chart](https://evil.example/pixel.png) and <https://evil.example/x>.")).toBe(
      "chart and https://evil.example/x.",
    );
    expect(rewrite(`![chart](${PRICING}) here.`)).toBe(`![chart](${PRICING}) here.`);
    expect(rewrite(`See <${PRICING}>.`)).toBe(`See <${PRICING}>.`);
    // Both go to one page, so the second in the paragraph is reduced to its text.
    expect(rewrite(`![chart](${PRICING}) and <${PRICING}>.`)).toBe(
      `![chart](${PRICING}) and ${PRICING}.`,
    );
  });

  it("reports no image as a link the answer gives, however it was written", () => {
    // The status page may be linked (pricing's text names it), but it is not
    // a page the answer was given: only a link to it should count.
    const IMAGE = `Check ![the status page](${STATUS}).`;
    const kept = rewriteSourceLinks(IMAGE, TARGETS);
    expect(kept.text).toBe(IMAGE);
    expect(kept.destinations).toEqual([]);
    expect(kept.linked).toEqual([]);
    for (let a = 1; a < IMAGE.length; a++) {
      const linker = sourceLinker(TARGETS);
      linker.push(IMAGE.slice(0, a));
      linker.push(IMAGE.slice(a));
      linker.flush();
      expect(linker.text).toBe(IMAGE);
      expect(linker.destinations, `cut at ${a}`).toEqual([]);
    }
    // Written before a pause, and with only its "!" written before one.
    expect(rewriteSourceLinks(" More.", TARGETS, IMAGE).destinations).toEqual([]);
    const split = rewriteSourceLinks(`[the status page](${STATUS}).`, TARGETS, "Check !");
    expect(split.text).toBe(`[the status page](${STATUS}).`);
    expect(split.destinations).toEqual([]);
    // A link is still one: in the paragraph after an image, or after an escaped "!".
    expect(rewriteSourceLinks(`![chart](${PRICING})\n\nSee [pricing][3].`, TARGETS)).toMatchObject({
      destinations: [PRICING],
      linked: [PRICING],
    });
    expect(rewriteSourceLinks(`\\![the status page](${STATUS})`, TARGETS).destinations).toEqual([
      STATUS,
    ]);
    // Before a pause, a link in an image's text is shown with the image as
    // written, so it is none either.
    expect(
      rewriteSourceLinks(" More.", TARGETS, `![see [the guide](${TESTING})](${STATUS})`)
        .destinations,
    ).toEqual([]);
    // After one, an image holding a link is reduced to its text, which then
    // is a link.
    const nested = rewriteSourceLinks(`![see [the guide][1]](${STATUS})`, TARGETS);
    expect(nested.text).toBe(`see [the guide](${TESTING})`);
    expect(nested.destinations).toEqual([TESTING]);
  });

  it("links a source at most once per paragraph, and again in the next one or a new list item", () => {
    expect(
      rewrite(
        [
          "Use [the guide][1] and [the testing guide][1] and [pricing][3].",
          "",
          "Then [the guide][1] again.",
          "- [testing][1] here",
          "- [testing][1] there [twice][1]",
        ].join("\n"),
      ),
    ).toBe(
      [
        `Use [the guide](${TESTING}) and the testing guide and [pricing](${PRICING}).`,
        "",
        `Then [the guide](${TESTING}) again.`,
        `- [testing](${TESTING}) here`,
        `- [testing](${TESTING}) there twice`,
      ].join("\n"),
    );
  });

  it("leaves code, escaped brackets and bare markers alone", () => {
    const text = [
      "Write `[a][1]` or `[b](https://evil.example)`, and \\[c][1].",
      "",
      "```js",
      "x = [y][1]; z = [w](https://evil.example);",
      "```",
      "",
      "    [v][1]",
      "",
      "Markers [1] and [2, 3] stay for the marker filter.",
    ].join("\n");
    expect(rewrite(text)).toBe(text);
  });

  it("keeps a destination with parentheses whole and writes the page's address so Markdown reads it", () => {
    const targets = linkTargets([{ url: "https://docs.example.com/a_(b) c", text: "" }]);
    expect(rewriteSourceLinks("[A][1]", targets).text).toBe(
      "[A](https://docs.example.com/a_%28b%29%20c)",
    );
    expect(rewriteSourceLinks("[A](https://docs.example.com/a_(b)%20c)", targets).text).toBe(
      "[A](https://docs.example.com/a_%28b%29%20c)",
    );
  });

  it("keeps an address with parentheses that a source's text contains whole", () => {
    const API = "https://docs.example.com/api_(v2)";
    const targets = linkTargets([
      { url: PRICING, text: `See ${API}. Also (${STATUS}) and ${API}#auth, or ${API}, not more.` },
    ]);
    // The complete address survives, written as the page's address.
    expect(rewriteSourceLinks(`[API documentation](${API})`, targets).text).toBe(
      "[API documentation](https://docs.example.com/api_%28v2%29)",
    );
    expect(rewriteSourceLinks(`[API](${API}#auth)`, targets).text).toBe(
      "[API](https://docs.example.com/api_%28v2%29#auth)",
    );
    // Its cut-off prefix was never supplied or mentioned, so it is rejected.
    expect(rewriteSourceLinks("[API](https://docs.example.com/api_)", targets).text).toBe("API");
    // An address in parentheses ends at the closing one, which is not part of it.
    expect(rewriteSourceLinks(`[status](${STATUS})`, targets).text).toBe(`[status](${STATUS})`);
    expect(targets.allowed).toEqual(new Set([PRICING, API, STATUS]));
  });

  it("keeps a link's title, and leaves a bracket that is no link as it is", () => {
    expect(rewrite(`[pricing](${PRICING} "Plans")`)).toBe(`[pricing](${PRICING})`);
    expect(rewrite("Press [Enter] then [Save](not a link")).toBe(
      "Press [Enter] then [Save](not a link",
    );
  });

  it("streams a link split anywhere as one whole piece, with the same result as at once", () => {
    const text = `Read [the testing guide][1], [pricing](${PRICING}) and [x](https://evil.example/a) now.`;
    const whole = rewrite(text);
    for (let a = 1; a < text.length; a++) {
      for (const b of [a + 1, a + 7, a + 23]) {
        if (b >= text.length) continue;
        const deltas = stream(text, [a, b]);
        expect(deltas.join("")).toBe(whole);
        // Nothing sent ever ends inside a link: each one arrives whole.
        let sent = "";
        for (const delta of deltas) {
          sent += delta;
          expect(whole.startsWith(sent)).toBe(true);
          const open = sent.lastIndexOf("[");
          if (open !== -1) expect(sent.slice(open)).toMatch(/^\[[^\]]*\]\([^)]*\)/u);
        }
      }
    }
  });

  it("holds an autolink, an image's '!' and a long unfinished label until they settle", () => {
    expect(stream(`See <${PRICING.slice(0, 12)}`, [])).toEqual([
      "See ",
      `<${PRICING.slice(0, 12)}`,
    ]);
    const deltas = stream("Look ![chart](https://evil.example/p.png) now", [6, 10]);
    expect(deltas.slice(0, 2)).toEqual(["Look ", ""]);
    expect(deltas.join("")).toBe("Look chart now");
    const long = `Read [${"the very long name of the testing guide ".repeat(5)}`;
    const held = stream(`${long}][1].`, [long.length]);
    expect(held[0]).toBe("Read ");
    expect(held[1]).toMatch(
      /^\[the very long .*\]\(https:\/\/docs\.example\.com\/guide\/testing\)\.$/u,
    );
  });

  it("reduces a link left unfinished at the end to its text, so none is left open", () => {
    expect(rewrite("Read [the testing guide](https://docs.example.com/gu")).toBe(
      "Read the testing guide",
    );
    expect(rewrite("Read [the testing guide][")).toBe("Read the testing guide");
    expect(rewrite("Read [the testing")).toBe("Read the testing");
    // A marker left open is for the marker filter, and a complete bracket is text.
    expect(rewrite("Done [1")).toBe("Done [1");
    expect(rewrite("Press [Enter]")).toBe("Press [Enter]");
  });

  it("continues a paused reply: its links count for the paragraph and its code is still code", () => {
    const before = `Open [the guide](${TESTING}) `;
    expect(rewrite("and [the guide][1] again.", before)).toBe("and the guide again.");
    expect(rewrite("\n\nThen [the guide][1].", before)).toBe(`\n\nThen [the guide](${TESTING}).`);
    expect(rewrite("y][1]` and [z][3].", "Code `x[")).toBe(`y][1]\` and [z](${PRICING}).`);
    // Pages it had before the pause may still be linked.
    const targets = linkTargets([], ["https://docs.example.com/old"]);
    expect(rewriteSourceLinks("[old](https://docs.example.com/old)", targets).text).toBe(
      "[old](https://docs.example.com/old)",
    );
  });

  describe("a backtick in a link's tail hides no link after it", () => {
    const PHISH = "https://unlisted.example/phish";
    // Each line: the answer, and what it must become. The first link's tail
    // holds a backtick the rewrite drops with the title, the unlisted
    // address or the reference; the link after it must still be checked.
    const cases: Array<[string, string, string]> = [
      [
        "a title",
        `[guide](${PRICING} "\`tag") then [other](${PHISH})`,
        `[guide](${PRICING}) then other`,
      ],
      [
        "an unlisted address",
        `[x](https://unlisted.example/a\`b) then [other](${PHISH})`,
        "x then other",
      ],
      ["a reference", `[x][1\`] then [other](${PHISH})`, "x then other"],
      [
        "an autolink",
        `<https://unlisted.example/a\`b> then [other](${PHISH}) and \`x\``,
        "https://unlisted.example/a`b then other and `x`",
      ],
    ];

    it.each(cases)("in %s, whole", (_name, text, expected) => {
      expect(rewrite(text)).toBe(expected);
      expect(rewriteSourceLinks(text, TARGETS).removed).toBe(
        expected.startsWith("[guide]") ? 1 : 2,
      );
    });

    it.each(cases)("in %s, split anywhere on the stream", (_name, text, expected) => {
      for (let a = 1; a < text.length; a++) {
        expect(stream(text, [a]).join("")).toBe(expected);
        const b = Math.min(a + 5, text.length - 1);
        if (b > a) expect(stream(text, [a, b]).join("")).toBe(expected);
      }
    });

    it("still keeps real code in a label and after the link as written", () => {
      const text = `[the \`npm test\` command](${PRICING} "Plans") and \`[raw](${PHISH})\``;
      expect(rewrite(text)).toBe(`[the \`npm test\` command](${PRICING}) and \`[raw](${PHISH})\``);
      // A "](" with no "[" before it is no link, so its backtick opens code.
      const plain = `See a](b "\`[raw](${PHISH})\`") now`;
      expect(rewrite(plain)).toBe(plain);
    });

    it("reads no link across a backslash at a line's end", () => {
      // The link is not one, so nothing on the next line is dropped with it.
      const text = `[x](https://unlisted.example/a\\\n\`) [other](${PHISH})`;
      const out = rewrite(text);
      expect(out.startsWith("[x](https://unlisted.example/a\\\n`)")).toBe(true);
    });
  });

  it("keeps line endings as written", () => {
    expect(rewrite("A [x][1]\r\n\r\nB [y][1]\r\n")).toBe(
      `A [x](${TESTING})\r\n\r\nB [y](${TESTING})\r\n`,
    );
  });

  describe("a link inside a link's text, or one left behind by a rewrite, is checked too", () => {
    const UNLISTED = "https://unlisted.example";
    // Each line: the answer, what it must become, and how many links were
    // reduced because of where they went.
    const cases: Array<[string, string, string, number]> = [
      [
        "a link in a link's text",
        `[outer [inner](${UNLISTED}/inner)](${UNLISTED}/outer)`,
        "outer inner",
        2,
      ],
      ["a reference in a link's text", `[outer [inner][9]](${UNLISTED}/outer)`, "outer inner", 2],
      [
        "an image in a link's text",
        `[outer ![inner](${UNLISTED}/i.png)](${UNLISTED}/outer)`,
        "outer inner",
        2,
      ],
      ["brackets in a link's text", `[see [the guide]](${UNLISTED}/x)`, "see [the guide]", 1],
      [
        "brackets in a link's text, then a destination",
        `[a [b]](${UNLISTED}/x)(${UNLISTED}/c)`,
        "a b",
        2,
      ],
      [
        "a source's link in an unlisted link's text",
        `[outer [inner][1]](${UNLISTED}/outer)`,
        `outer [inner](${TESTING})`,
        1,
      ],
      [
        "an unlisted link in a source's link's text",
        `[outer [inner](${UNLISTED}/i)](${PRICING})`,
        "outer inner",
        1,
      ],
      [
        "an autolink in a source's link's text",
        `[a <${UNLISTED}/a> b](${PRICING})`,
        `a ${UNLISTED}/a b`,
        1,
      ],
      [
        "an image reduced to nothing between a bracket and a destination",
        `[x]![](${UNLISTED}/i)(${UNLISTED}/c)`,
        "x",
        2,
      ],
      [
        "an autolink reduced to an address ending in a bracket",
        `[x <${UNLISTED}/a]>(${UNLISTED}/c)`,
        `x ${UNLISTED}/a`,
        2,
      ],
      [
        "an autolink reduced to an address holding a bracket",
        `<${UNLISTED}/a[>](${UNLISTED}/c)`,
        `${UNLISTED}/a`,
        2,
      ],
    ];

    it.each(cases)("%s, whole", (_name, text, expected, removed) => {
      const result = rewriteSourceLinks(text, TARGETS);
      expect(result.text).toBe(expected);
      expect(result.removed).toBe(removed);
      // What is left reads as it is: nothing in it is a link not checked.
      expect(rewrite(result.text)).toBe(result.text);
    });

    it.each(cases)("%s, split anywhere on the stream", (_name, text, expected) => {
      for (let a = 1; a < text.length; a++) {
        for (const b of [a + 1, a + 9]) {
          const deltas = stream(text, b < text.length ? [a, b] : [a]);
          expect(deltas.join("")).toBe(expected);
          // Nothing sent is taken back: each delta continues the result.
          let sent = "";
          for (const delta of deltas) {
            sent += delta;
            expect(expected.startsWith(sent)).toBe(true);
          }
        }
      }
    });

    it("still keeps a source's link as written, reading it again", () => {
      // The address it writes reads back as the page it is, so it stays.
      const targets = linkTargets([{ url: "https://docs.example.com/a_(b) c", text: "" }]);
      const result = rewriteSourceLinks("[A][1] and [B](1)", targets);
      expect(result.text).toBe("[A](https://docs.example.com/a_%28b%29%20c) and B");
      expect(result.destinations).toEqual(["https://docs.example.com/a_(b)%20c"]);
      expect(result.removed).toBe(0);
    });
  });

  describe("a paused reply: a link begun before the pause is not finished after it", () => {
    const UNLISTED = "https://unlisted.example/c";
    const cases: Array<[string, string, string, string, number]> = [
      ["a destination", "See [x]", `(${UNLISTED}) more`, " more", 1],
      ["a source's number", "See [the guide]", "[1] for more", " for more", 0],
      ["an autolink's close", `See <${UNLISTED}`, "> more", " more", 1],
      ["an autolink's address", `See <${UNLISTED}`, "/more> now", "/more now", 1],
    ];

    it.each(cases)("%s, whole", (_name, before, text, expected, removed) => {
      const result = rewriteSourceLinks(text, TARGETS, before);
      expect(result.text).toBe(expected);
      expect(result.removed).toBe(removed);
      expect(result.destinations).toEqual([]);
      // The stored reply, read again, links nowhere.
      expect(linkDestinations(before + result.text)).toEqual([]);
    });

    it.each(cases)("%s, split anywhere on the stream", (_name, before, text, expected) => {
      for (let a = 1; a < text.length; a++) {
        expect(stream(text, [a], before).join("")).toBe(expected);
      }
    });
  });

  describe("linkDestinations", () => {
    it("reads where a text's links go, rewriting nothing", () => {
      const text = [
        `See [the steps](${TESTING}#steps), [pricing][3], [1] and <${STATUS}>.`,
        `Also [mail](mailto:help@example.com), \`[code](${PRICING})\` and ![chart](${PRICING}).`,
      ].join("\n");
      // The image is no link: the widget shows it as written.
      expect(linkDestinations(text)).toEqual([`${TESTING}#steps`, STATUS]);
    });

    it("counts no image, nor a link or autolink in an image's text", () => {
      expect(linkDestinations(`![chart](${PRICING}) and ![status][1].`)).toEqual([]);
      expect(linkDestinations(`![see [the guide](${TESTING})](${PRICING})`)).toEqual([]);
      expect(linkDestinations(`![see <${STATUS}>](${PRICING})`)).toEqual([]);
      // An escaped "!" makes none, so the link after it is one.
      expect(linkDestinations(`\\![the guide](${TESTING})`)).toEqual([TESTING]);
      // A link after an image in the same paragraph is one.
      expect(linkDestinations(`![chart](${PRICING}) and [pricing](${PRICING}).`)).toEqual([
        PRICING,
      ]);
    });

    it("counts the link inside another link's text, not the outer one", () => {
      expect(linkDestinations(`[outer [inner](${TESTING})](${PRICING})`)).toEqual([TESTING]);
      expect(linkDestinations(`[see [the guide]](${PRICING})`)).toEqual([]);
    });
  });

  describe("whatever the model writes", () => {
    const OK = "https://ok.example/a";
    const targets = linkTargets([{ url: OK, text: "" }]);
    const allowed = (href: string) => {
      const key = pageKey(href);
      return key === null || key === pageKey(OK);
    };
    /** The addresses the widget would make links of (`findLinkEnd` in its renderer), at any "[". */
    const widgetLinks = (text: string): string[] => {
      const hrefs: string[] = [];
      for (let at = 0; at < text.length; at++) {
        if (text[at] !== "[" || text[at - 1] === "!") continue;
        const close = text.indexOf("]", at + 1);
        if (close === -1 || text.slice(at, close).includes("\n") || text[close + 1] !== "(") {
          continue;
        }
        let depth = 1;
        for (let p = close + 2; p < text.length && !/[\s]/u.test(text[p] as string); p++) {
          if (text[p] === "(") depth++;
          if (text[p] === ")" && --depth === 0) {
            hrefs.push(text.slice(close + 2, p));
            break;
          }
        }
      }
      return hrefs;
    };
    // Pieces of Markdown link syntax, and addresses allowed and not.
    const pieces = [..."[]()<> \nx1", "![", OK, "https://bad.example/b"];
    let seed = 7;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const texts = Array.from({ length: 300 }, () =>
      Array.from(
        { length: 3 + Math.floor(next() * 12) },
        () => pieces[Math.floor(next() * pieces.length)],
      ).join(""),
    );

    it("sends no link to an unlisted page, whole, streamed or across a pause", () => {
      for (const text of texts) {
        const out = rewriteSourceLinks(text, targets).text;
        expect(rewriteSourceLinks(out, targets).text, text).toBe(out);
        expect(linkDestinations(out).every(allowed), text).toBe(true);
        expect(widgetLinks(out).every(allowed), text).toBe(true);
        const cut = Math.floor(text.length / 2);
        const linker = sourceLinker(targets);
        const deltas = [
          linker.push(text.slice(0, cut)),
          linker.push(text.slice(cut)),
          linker.flush(),
        ];
        expect(deltas.join(""), text).toBe(out);
        // Paused at the cut: the stored part, then the rest written after it.
        const before = rewriteSourceLinks(text.slice(0, cut), targets).text;
        const stored = before + rewriteSourceLinks(text.slice(cut), targets, before).text;
        expect(linkDestinations(stored).every(allowed), text).toBe(true);
        expect(widgetLinks(stored).every(allowed), text).toBe(true);
      }
    });
  });
});
