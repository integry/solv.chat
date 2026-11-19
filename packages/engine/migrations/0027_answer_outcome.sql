-- What a reviewer decided an assistant reply to a visitor did, written after
-- the reply was sent (see "Answer review" in docs/architecture.md). NULL when
-- the reply was not reviewed: written before this, review switched off, the
-- spend cap reached, a paused reply, or a review that failed or returned
-- anything but one of the five labels. `answered` is left as it was: it still
-- means "retrieval found content above the floor".
ALTER TABLE messages ADD COLUMN outcome TEXT
  CHECK (outcome IN ('answered', 'partial', 'declined', 'off_topic', 'wants_human'));
-- How sure the reviewer was, 0 to 1, when its backend can say; nothing reads
-- it yet. The fast-tier model reviewer cannot, so it stays NULL today.
ALTER TABLE messages ADD COLUMN outcome_confidence REAL
  CHECK (outcome_confidence IS NULL OR (outcome_confidence >= 0 AND outcome_confidence <= 1));

-- No index on `outcome`: Gaps, the reports and the Conversations filters
-- reach a reply through its conversation, its question or the role and time
-- index, and filter the outcome there (0030 explains, and drops the one this
-- file first created).

-- The "Review answers" switch (Settings → Providers). NULL means the
-- default, which is on; 0 switches review off for the whole organisation.
ALTER TABLE org_provider_settings ADD COLUMN review_answers INTEGER
  CHECK (review_answers IN (0, 1));
