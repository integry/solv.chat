-- An off-topic question gets no topic (see "Topics" in docs/architecture.md):
-- it is not about the site, so it must not fill Reports → Topics or the
-- Conversations topic filter. The "Off topic" filter is how the owner finds
-- these. Before this, the answer review tagged them like any question.
--
-- Clears `topic_id` on visitor questions whose reply was reviewed as
-- `off_topic`, in every org, each question matched to its reply within its
-- own org.
--
-- Topics are kept, even one left with no questions by this: `topics` does not
-- record whether the owner renamed a topic (owners cannot create one), so an
-- owner-renamed topic cannot be told from one the review named, and none is
-- deleted. An empty topic counts no questions, so the Topics list leaves it
-- out; the owner can delete it in "Manage topics".
UPDATE messages
   SET topic_id = NULL
 WHERE role = 'user'
   AND topic_id IS NOT NULL
   AND EXISTS (
     SELECT 1 FROM messages a
      WHERE a.org_id = messages.org_id
        AND a.reply_to = messages.id
        AND a.role = 'assistant'
        AND a.outcome = 'off_topic'
   );
