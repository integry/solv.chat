import { describe, expect, it } from "vitest";
import { isId, newId } from "./ids.js";

describe("ids", () => {
  it("creates identifiers that validate against their own prefix only", () => {
    const id = newId("ast");
    expect(isId(id, "ast")).toBe(true);
    expect(isId(id, "org")).toBe(false);
  });

  it("does not repeat", () => {
    const seen = new Set(Array.from({ length: 1000 }, () => newId("msg")));
    expect(seen.size).toBe(1000);
  });

  it("rejects malformed values", () => {
    for (const value of ["", "ast_", "ast_ABC", `ast_${"a".repeat(21)}`, 42, null]) {
      expect(isId(value, "ast")).toBe(false);
    }
  });
});
