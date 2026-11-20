import { describe, expect, it } from "vitest";
import { markerStripper, stripCitationMarkers } from "../../src/chat/citationMarkers.js";

const MAX = 6;

/** Streams `chunks` through a stripper and returns what the visitor got. */
function streamed(chunks: readonly string[], before = ""): { sent: string[]; text: string } {
  const stripper = markerStripper(MAX, before);
  const sent = chunks.map((chunk) => stripper.push(chunk));
  sent.push(stripper.flush());
  return { sent, text: sent.join("") };
}

describe("chat/citationMarkers", () => {
  it("takes out markers with the spaces before them", () => {
    expect(stripCitationMarkers("Open at 9 [1].", MAX)).toBe("Open at 9.");
    expect(stripCitationMarkers("Open at 9.[2] Closed Sundays [1, 3].", MAX)).toBe(
      "Open at 9. Closed Sundays.",
    );
    expect(stripCitationMarkers("Refunds take 30 days [1][2] and are free [2] [3].", MAX)).toBe(
      "Refunds take 30 days and are free.",
    );
    expect(stripCitationMarkers("[1] Start here.", MAX)).toBe(" Start here.");
    expect(stripCitationMarkers("See the steps [1-3].\n\nNext [4]\n", MAX)).toBe(
      "See the steps.\n\nNext\n",
    );
  });

  it("leaves the site's own text alone", () => {
    for (const text of [
      "Founded in [2024].",
      "Room [42] is upstairs.",
      "Use `items[1]` to read the second item.",
      "Read [1](https://site.example/one) first.",
      "Step [0] is optional.",
      "The [draft] label.",
      "Source 1 of our water is the lake.",
    ]) {
      expect(stripCitationMarkers(text, MAX)).toBe(text);
    }
    // Above the number of sources a prompt can carry.
    expect(stripCitationMarkers("Table [7].", MAX)).toBe("Table [7].");
    expect(stripCitationMarkers("Pages [1, 9].", MAX)).toBe("Pages [1, 9].");
  });

  it("judges each bracket next to another on its own", () => {
    const cases: Array<[string, string]> = [
      ["Choose option [42] [1].", "Choose option [42]."],
      ["Choose option [1] [42].", "Choose option [42]."],
      ["Choose option [42][1].", "Choose option [42]."],
      ["Choose option [1][42][2].", "Choose option[42]."],
      ["Pages [1, 9] [2] and [0] [3].", "Pages [1, 9] and [0]."],
      ["Room [2024] [1] [42] [2].", "Room [2024] [42]."],
      ["Read [42] [1](https://site.example/a) [2].", "Read [42] [1](https://site.example/a)."],
      ["Read [1] [42](https://site.example/a).", "Read [42](https://site.example/a)."],
    ];
    for (const [answer, expected] of cases) {
      expect(stripCitationMarkers(answer, MAX)).toBe(expected);
      // The same in every two- and three-chunk split of the stream.
      for (let a = 0; a <= answer.length; a++) {
        expect(streamed([answer.slice(0, a), answer.slice(a)]).text).toBe(expected);
        for (let b = a; b <= answer.length; b++) {
          const { text } = streamed([answer.slice(0, a), answer.slice(a, b), answer.slice(b)]);
          expect(text).toBe(expected);
        }
      }
    }
    // A paused reply's continuation goes through the same helper.
    expect(streamed(["[42] [", "1] next."], "Choose option").text).toBe("[42] next.");
  });

  it("takes out a marker split between two stream chunks", () => {
    const { sent, text } = streamed(["Click Forgot Password [", "1] to reset."]);
    expect(text).toBe("Click Forgot Password to reset.");
    // The space and "[" waited for the next chunk; nothing was sent twice.
    expect(sent[0]).toBe("Click Forgot Password");
    expect(sent.some((part) => part.includes("["))).toBe(false);
  });

  it("holds a finished marker until the next chunk shows it is not a link", () => {
    expect(streamed(["Read [1]", "(https://site.example/a) now."]).text).toBe(
      "Read [1](https://site.example/a) now.",
    );
    expect(streamed(["Read [1]", " now."]).text).toBe("Read now.");
    expect(streamed(["Done [1]"]).text).toBe("Done");
  });

  it("sends a held tail once it cannot be a marker", () => {
    const { sent, text } = streamed(["Room [", "42] is upstairs."]);
    expect(text).toBe("Room [42] is upstairs.");
    expect(sent[0]).toBe("Room");
    expect(sent[1]).toBe(" [42] is upstairs.");
  });

  it("adds up to the same text as stripping the whole answer, however it is split", () => {
    const answers = [
      "Click Forgot Password [1]. Then check your email [2][3].\n\nStill stuck? Room [42] helps [1, 2].",
      "Use `items[1]` [2] and read [1](https://a.example) [3] at 9.[1]",
      "  [1] [2]  spaced  [3]   end [4]",
      "Click Forgot Password[1]. Answer [1, 2, 3, 4, 5, 6, 1, 2, 3]. More[2].",
      "Run:\n```sh\nls dir[1]\n```\nThen `x[2]`[3] and ``y`[1]`` z[4].\n\nOdd ` tick[1]\n  \nAfter[2].",
      "Codes [1, 2, 3, 4, 5, 6, 1, 2, 3, 4, 5, 99] stay [5].",
      "```text\n```not-a-close\nitems[1]\n```  [2]\n``` \nDone[1].",
      "Example:\n\n    items[1]\n\n\tx[2]\nDone[1].\n- Step [2]\n\n    Save [3].\n\n      y[4]\n",
    ];
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (const answer of answers) {
      const whole = stripCitationMarkers(answer, MAX);
      for (let round = 0; round < 200; round++) {
        const chunks: string[] = [];
        let at = 0;
        while (at < answer.length) {
          const size = 1 + Math.floor(random() * 5);
          chunks.push(answer.slice(at, at + size));
          at += size;
        }
        const stripper = markerStripper(MAX);
        const joined = chunks.map((chunk) => stripper.push(chunk)).join("") + stripper.flush();
        expect(joined).toBe(whole);
        expect(stripper.text).toBe(whole);
      }
    }
  });

  it("takes out a marker attached to a word in prose", () => {
    expect(stripCitationMarkers("Click Forgot Password[1].", MAX)).toBe("Click Forgot Password.");
    expect(stripCitationMarkers("Open at 9[2][3] daily[1, 2].", MAX)).toBe("Open at 9 daily.");
    expect(streamed(["Click Forgot Password[", "1]. Then sign in[2]."]).text).toBe(
      "Click Forgot Password. Then sign in.",
    );
  });

  it("leaves markers inside code spans and fenced blocks alone", () => {
    for (const text of [
      "Use `items[1]` and ``list[2]`` here.",
      "```js\nconst first = items[1];\nconst pair = [1, 2];\n```",
      "~~~\nrow[3]\n~~~",
      "Unclosed fence:\n```\nitems[1]",
    ]) {
      expect(stripCitationMarkers(text, MAX)).toBe(text);
    }
    expect(stripCitationMarkers("```\nitems[1]\n```\nDone[1].", MAX)).toBe(
      "```\nitems[1]\n```\nDone.",
    );
    // A stray backtick protects only its own paragraph.
    expect(stripCitationMarkers("It's ` odd[1].\n\nNext[2].", MAX)).toBe("It's ` odd[1].\n\nNext.");
  });

  it("keeps a fence open past a fence-like line with text after it", () => {
    const answer = "```text\n```not-a-close\nitems[1]\n```\nDone[1].";
    const expected = "```text\n```not-a-close\nitems[1]\n```\nDone.";
    expect(stripCitationMarkers(answer, MAX)).toBe(expected);
    expect(stripCitationMarkers("~~~\n~~~ x [2]\nrow[3]\n~~~", MAX)).toBe(
      "~~~\n~~~ x [2]\nrow[3]\n~~~",
    );
    // Only spaces may follow a real closing fence.
    expect(stripCitationMarkers("```\nitems[1]\n```  \t\nDone[1].", MAX)).toBe(
      "```\nitems[1]\n```  \t\nDone.",
    );
    // Streamed, split at every point, including right after the fake closer.
    for (let cut = 1; cut < answer.length; cut++) {
      const stripper = markerStripper(MAX);
      const joined =
        stripper.push(answer.slice(0, cut)) + stripper.push(answer.slice(cut)) + stripper.flush();
      expect(joined).toBe(expected);
      expect(stripper.text).toBe(expected);
    }
    expect(streamed(["```text\n```", "not-a-close\nitems[", "1]\n```\nDone[1]."]).text).toBe(
      expected,
    );
    // A continuation that starts on the fake closer's line.
    expect(streamed(["not-a-close\nitems[1]\n```\nDone[1]."], "```text\n```").text).toBe(
      "not-a-close\nitems[1]\n```\nDone.",
    );
  });

  it("leaves markers inside indented code blocks alone", () => {
    expect(stripCitationMarkers("Example:\n\n    items[1]\n", MAX)).toBe(
      "Example:\n\n    items[1]\n",
    );
    expect(stripCitationMarkers("    first = items[1]", MAX)).toBe("    first = items[1]");
    expect(stripCitationMarkers("Tab:\n\n\titems[2]\n", MAX)).toBe("Tab:\n\n\titems[2]\n");
    // Several lines, a blank line inside the block, then prose again.
    expect(
      stripCitationMarkers("Run:\n\n    a = x[1]\n\n    b = x[2]\nDone[1].\n\nNext[3].", MAX),
    ).toBe("Run:\n\n    a = x[1]\n\n    b = x[2]\nDone.\n\nNext.");
    // Right after a heading or a closing fence, no blank line needed.
    expect(stripCitationMarkers("## Usage\n    items[1]", MAX)).toBe("## Usage\n    items[1]");
    expect(stripCitationMarkers("```\nx\n```\n    items[1]", MAX)).toBe(
      "```\nx\n```\n    items[1]",
    );
    // Inside a list item, code is indented four past the item's text.
    expect(stripCitationMarkers("- Step:\n\n      items[1]\n", MAX)).toBe(
      "- Step:\n\n      items[1]\n",
    );
  });

  it("still takes markers out of indented text that is not code", () => {
    // A paragraph's next line, however indented, is still the paragraph.
    expect(stripCitationMarkers("Open at 9\n    daily [1].", MAX)).toBe("Open at 9\n    daily.");
    // Text indented to stay inside a list item is the item's text.
    expect(stripCitationMarkers("1. Go to Settings.\n\n    Then click Save [1].", MAX)).toBe(
      "1. Go to Settings.\n\n    Then click Save.",
    );
    expect(stripCitationMarkers("- Go to Settings.\n\n    Then click Save [1].", MAX)).toBe(
      "- Go to Settings.\n\n    Then click Save.",
    );
    // After the list ends, four spaces make code again.
    expect(stripCitationMarkers("- One [1]\n\nDone [2].\n\n    items[3]", MAX)).toBe(
      "- One\n\nDone.\n\n    items[3]",
    );
  });

  it("keeps indented code when streamed in any split", () => {
    const answer = "Example:\n\n    items[1]\n    pair[2]\n\nUse it [1].";
    const expected = "Example:\n\n    items[1]\n    pair[2]\n\nUse it.";
    for (let cut = 1; cut < answer.length; cut++) {
      for (let second = cut + 1; second < answer.length; second++) {
        const stripper = markerStripper(MAX);
        const joined =
          stripper.push(answer.slice(0, cut)) +
          stripper.push(answer.slice(cut, second)) +
          stripper.push(answer.slice(second)) +
          stripper.flush();
        expect(joined).toBe(expected);
        expect(stripper.text).toBe(expected);
      }
    }
    // A continuation whose first part ended at a blank line.
    expect(streamed(["    items[1]\nDone[2]."], "Example:\n\n").text).toBe("    items[1]\nDone.");
    expect(streamed(["items[1]\n"], "Example:\n\n    ").text).toBe("items[1]\n");
  });

  it("holds a long unfinished marker group instead of sending it early", () => {
    const { sent, text } = streamed(["Answer [1, 2, 3, 4, 5, 6, 1, 2, 3", "]. More instructions."]);
    expect(sent[0]).toBe("Answer");
    expect(text).toBe("Answer. More instructions.");
    const stripper = markerStripper(MAX);
    stripper.push("Answer [1, 2, 3, 4, 5, 6, 1, 2, 3");
    stripper.push("]. More instructions.");
    stripper.flush();
    expect(stripper.text).toBe("Answer. More instructions.");
  });

  it("sends a long bracket of digits once it cannot be a marker", () => {
    expect(streamed(["Codes [1, 2, 3, 4, 5, 6, 1, 2, 3, 4, 5", ", 99] apply."]).text).toBe(
      "Codes [1, 2, 3, 4, 5, 6, 1, 2, 3, 4, 5, 99] apply.",
    );
  });

  it("reads the text before a continuation to know whether it starts in code", () => {
    expect(streamed(["[1] more."], "Let me check").text).toBe(" more.");
    expect(streamed(["[1] more."], "Done.").text).toBe(" more.");
    expect(streamed(["[1];\n```\nDone[2]."], "```js\nconst a = items").text).toBe(
      "[1];\n```\nDone.",
    );
    expect(streamed(["[1]` works."], "Try `items").text).toBe("[1]` works.");
  });
});
