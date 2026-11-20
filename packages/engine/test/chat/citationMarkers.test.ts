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
