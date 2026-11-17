-- Getting-started checklist on the Overview screen. Both are set once, the
-- first time it happens, and never cleared.
-- When the owner first asked a question in the admin "Try it" pane (previews
-- store no conversation, so nothing else records it).
ALTER TABLE assistants ADD COLUMN tried_at INTEGER;
-- When the widget first loaded its config from one of the allowed origins:
-- the snippet is on the owner's site.
ALTER TABLE assistants ADD COLUMN widget_seen_at INTEGER;

-- Gaps the owner dismissed. Keyed by the normalised question text the Gaps
-- screen groups on; a question asked again after `dismissed_at` shows again.
CREATE TABLE gap_dismissals (
  org_id TEXT NOT NULL REFERENCES orgs(id),
  assistant_id TEXT NOT NULL,
  question_key TEXT NOT NULL,
  dismissed_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, assistant_id, question_key),
  FOREIGN KEY (org_id, assistant_id) REFERENCES assistants(org_id, id) ON DELETE CASCADE
);
