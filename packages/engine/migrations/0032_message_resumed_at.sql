-- When a page-action continuation last saved a reply (see "Answer review" in
-- docs/architecture.md). A paused reply keeps its `created_at`, and the live
-- review starts only once a continuation completes it, perhaps long after.
-- The review catch-up waits `REVIEW_CATCH_UP_MIN_AGE_MS` past this (or past
-- `created_at` when it is NULL: a reply that never paused, or one written
-- before this), so it never reviews a reply its live review is still on.
-- Written in the same update as the continuation's text, so it is never older
-- than the answer.
ALTER TABLE messages ADD COLUMN resumed_at INTEGER;
