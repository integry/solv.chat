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

-- Gaps and the Reports gap list read the replies that were not answered:
-- `answered = 0` (served by messages_unanswered) or `outcome = 'declined'`
-- (served by this one), and the Conversations filters read the outcome too.
-- `created_at` lets the reports' date range use it as well.
CREATE INDEX messages_org_outcome ON messages(org_id, outcome, created_at);

-- The "Review answers" switch (Settings → Providers). NULL means the
-- default, which is on; 0 switches review off for the whole organisation.
ALTER TABLE org_provider_settings ADD COLUMN review_answers INTEGER
  CHECK (review_answers IN (0, 1));
