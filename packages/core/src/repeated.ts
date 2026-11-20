/**
 * One block of text left out of a source's pages because it repeats across
 * most of them (see "Repeated blocks" in docs/architecture.md).
 */
export interface RepeatedBlock {
  /**
   * The block's first 80 characters, read back from a page's stored text;
   * null when none of the pages read for the list holds it.
   */
  text: string | null;
  /** True when the block is longer than `text`. */
  truncated: boolean;
  /** On how many of the source's pages it is. */
  pages: number;
}

/** `GET /api/admin/sources/:id/repeated-blocks`. */
export interface RepeatedBlocks {
  /** Most pages first. */
  blocks: RepeatedBlock[];
}
