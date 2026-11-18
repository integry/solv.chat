-- Which documents each assistant reply to a visitor was given to answer
-- from, by document id: pages, pushed documents and answers written in the
-- admin alike (see "Content used" in docs/architecture.md).
--
-- Reports counted usage by matching `documents.url` against the `url` in
-- `messages.citations`. Citations hold only what a visitor can follow, so a
-- written answer (whose address is an admin page) was never there and never
-- counted. This table is internal: nothing here is shown to a visitor, and
-- `messages.citations` keeps holding only public addresses, so no admin
-- address or document id can reach the widget or the public API by mistake.
-- A join table rather than an extra entry in the citations JSON for that
-- reason, and because the report counts it with an index instead of parsing
-- JSON.
--
-- Written in the same batch as the reply (and by a resume, under its claim).
-- Deleted with the message, like `message_traces`. `document_id` has no
-- foreign key on purpose: deleting a document keeps the record that it was
-- used, and the report joins live documents, so a deleted one drops out of
-- the lists for every period (no broken row, no count of something that can
-- no longer be opened). Replies written before this table have no rows; the
-- report falls back to their URL citations, as it counted before.
CREATE TABLE message_documents (
  org_id TEXT NOT NULL REFERENCES orgs(id),
  message_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  PRIMARY KEY (org_id, message_id, document_id),
  FOREIGN KEY (org_id, message_id) REFERENCES messages(org_id, id) ON DELETE CASCADE
) WITHOUT ROWID;
