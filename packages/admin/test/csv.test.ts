import { describe, expect, it } from "vitest";
import { buildCsv } from "../src/csv.js";

describe("buildCsv", () => {
  it("quotes, doubles and defuses a question a spreadsheet would evaluate", () => {
    const csv = buildCsv([
      {
        title: "Most asked questions",
        header: ["Question", "Times"],
        rows: [
          ['=1+1, and "why"?\nSecond line', 3],
          ["+44 phone support?", 1],
          ["@mentions?", 1],
          ["-5% discount?", 1],
        ],
      },
    ]);

    // No sep=, hint line.
    expect(csv.startsWith("sep=")).toBe(false);
    // Every field quoted, inner quotes doubled, newline kept inside the field.
    expect(csv).toContain(`"'=1+1, and ""why""?\nSecond line","3"`);
    // The three other formula starts a spreadsheet would evaluate.
    expect(csv).toContain(`"'+44 phone support?"`);
    expect(csv).toContain(`"'@mentions?"`);
    expect(csv).toContain(`"'-5% discount?"`);
    // CRLF, because the file is for spreadsheet software.
    expect(csv.endsWith("\r\n")).toBe(true);
    const withoutQuotedNewline = csv.replace("\nSecond line", " Second line");
    expect(withoutQuotedNewline.split("\r\n").length).toBe(7);
  });

  it("writes an empty field for null or missing values rather than undefined", () => {
    const csv = buildCsv([
      {
        title: "t",
        header: ["a", "b", "c"],
        rows: [["x", undefined, null]],
      },
    ]);
    expect(csv).toContain('"x","",""');
    expect(csv).not.toContain("undefined");
    expect(csv).not.toContain("null");
  });
});
