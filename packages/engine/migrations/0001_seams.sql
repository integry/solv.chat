CREATE TABLE IF NOT EXISTS orgs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_daily (
  org_id TEXT NOT NULL REFERENCES orgs(id),
  assistant_id TEXT NOT NULL,
  day TEXT NOT NULL,
  messages INTEGER NOT NULL DEFAULT 0,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cost_micros INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, assistant_id, day)
);

CREATE TABLE IF NOT EXISTS rate_counters (
  org_id TEXT NOT NULL REFERENCES orgs(id),
  assistant_id TEXT NOT NULL,
  ip TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, assistant_id, ip, window_start)
);

CREATE TABLE IF NOT EXISTS login_failures (
  org_id TEXT NOT NULL REFERENCES orgs(id),
  ip TEXT NOT NULL,
  failures INTEGER NOT NULL,
  window_start INTEGER NOT NULL,
  PRIMARY KEY (org_id, ip)
);
