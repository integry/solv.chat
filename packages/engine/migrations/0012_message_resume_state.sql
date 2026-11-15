-- Server-side continuation state for paused page-action replies:
-- * resume_context: bounded model tool-exchange context preserved across pauses,
--   kept separate from the owner-facing tool_calls summary and cleared on completion.
-- * resume_revision: incremented on every resume completion so stale claims or
--   out-of-order completions cannot overwrite newer state.
-- * resume_claim / resume_claimed_at: atomic lease preventing concurrent resumes
--   from running or overwriting the same paused reply, with TTL recovery if a
--   worker is interrupted mid-flight.
ALTER TABLE messages ADD COLUMN resume_context TEXT;
ALTER TABLE messages ADD COLUMN resume_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN resume_claim TEXT;
ALTER TABLE messages ADD COLUMN resume_claimed_at INTEGER;
