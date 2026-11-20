-- Whether the visitor was shown a reply's citations: the version's "Show
-- sources in answers" when the reply was written. `citations` is kept either
-- way (the owner's record of the pages an answer used); this says whether the
-- admin calls them the answer's sources or only the content it used. Every
-- reply written before this showed its citations, hence the default.
ALTER TABLE messages ADD COLUMN citations_shown INTEGER NOT NULL DEFAULT 1;
