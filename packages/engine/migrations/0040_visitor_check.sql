-- Visitor check and per-visitor caps (issue #133; see "Visitor check" in
-- docs/architecture.md). Neither table is read with conversations, and
-- neither holds a token, a session or an IP in the clear.

-- Turnstile tokens already exchanged for a session, by SHA-256 hash, kept
-- until they expire (300 seconds after they were issued, per the Siteverify
-- documentation). Turnstile's own reuse check is eventually consistent, so
-- this table is what makes "a token cannot be exchanged twice" hold for
-- requests seconds apart. The key is the hash alone: a token is the
-- operator's, not an org's, so it may be spent once across every org.
CREATE TABLE visitor_check_tokens (
  token_hash TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  expires_at INTEGER NOT NULL
);
CREATE INDEX visitor_check_tokens_expiry ON visitor_check_tokens(org_id, expires_at);

-- Counters for the visitor caps. `subject` is an HMAC of the visitor id or
-- the IP under a key derived from SOLV_SECRET_KEY, never the value itself.
-- `counter` is one of visitor_day, ip_day, ip_sessions_hour; `window_start`
-- is the start of the UTC day or hour the hits belong to.
CREATE TABLE visitor_counters (
  org_id TEXT NOT NULL REFERENCES orgs(id),
  assistant_id TEXT NOT NULL,
  counter TEXT NOT NULL CHECK (counter IN ('visitor_day', 'ip_day', 'ip_sessions_hour')),
  subject TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, assistant_id, counter, subject, window_start)
);
CREATE INDEX visitor_counters_window ON visitor_counters(org_id, counter, window_start);
