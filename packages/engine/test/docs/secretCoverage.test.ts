import { describe, expect, it } from "vitest";
import guide from "../../../../docs/self-hosting.md?raw";
import { EMBEDDING_MODEL } from "../../src/models.js";
import { VECTORIZE_METADATA_PROPERTIES } from "../../src/providers/retrieval.js";

const engineSources = import.meta.glob("../../src/**/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

describe("self-hosting guide coverage", () => {
  /**
   * Every SOLV_ name the engine reads must be named in the self-hosting guide.
   *
   * Scanning the source rather than a hand-kept list: a list would be the second
   * thing to forget to update, right after the guide itself. Reading the names
   * out of the source means adding a secret and forgetting to document it fails
   * the build, in the same pull request that added it.
   */
  it("documents every SOLV_ environment name the engine reads", () => {
    const names = new Set<string>();
    for (const source of Object.values(engineSources)) {
      for (const match of source.matchAll(/\bSOLV_[A-Z_]+\b/g)) {
        names.add(match[0]);
      }
    }

    expect(names.size).toBeGreaterThan(0);
    for (const name of names) {
      expect(guide, `${name} is not in docs/self-hosting.md`).toContain(name);
    }
  });

  /**
   * The Vectorize index is created once, by hand, with a dimension count taken
   * from this guide. A mismatch with EMBEDDING_MODEL fails only at the first
   * embed — long after setup, and with an error that points at the wrong thing.
   */
  it("names the embedding dimensions the engine actually uses", () => {
    expect(guide).toMatch(
      new RegExp(
        `vectorize create\\b[^\\n]*--dimensions(?:=|\\s+)${EMBEDDING_MODEL.dimensions}\\b`,
      ),
    );
  });

  /**
   * Vectorize only filters on metadata properties that have an index created
   * before vectors are upserted. Missing one leaves every query returning no
   * matches.
   */
  it("creates a metadata index for every property the retriever filters on", () => {
    for (const property of Object.values(VECTORIZE_METADATA_PROPERTIES)) {
      expect(
        guide,
        `Missing create-metadata-index command for ${property} in docs/self-hosting.md`,
      ).toMatch(
        new RegExp(
          `vectorize create-metadata-index\\b[^\\n]*--property-name(?:=|\\s+)${property}\\b`,
        ),
      );
    }
  });
});
