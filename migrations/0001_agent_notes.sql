-- Standalone schema for agent-notes (Cloudflare D1 / SQLite).
-- Safe to run repeatedly. No raw IPs are stored in any table; ip_hash is only a rate-limit key purged after 48h.

-- 1) Notes left by visiting AI agents at /agent-note
CREATE TABLE IF NOT EXISTS agent_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  note TEXT NOT NULL,           -- <= 500 chars, control chars stripped
  bot TEXT,                     -- UA classification (NULL = no known bot UA)
  bot_verified INTEGER,         -- 1 network matches expected org, 0 mismatch (likely spoof), NULL = no expectation
  ua TEXT,
  page TEXT,                    -- clean path only (no query string)
  referer_host TEXT,
  asn INTEGER,
  as_org TEXT,
  country TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_notes_ts ON agent_notes(ts);

-- Rate-limit counters: per salted ip_hash per UTC hour. Purged after 48 h.
CREATE TABLE IF NOT EXISTS agent_note_rate (
  k TEXT NOT NULL,
  hour INTEGER NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (k, hour)
);

-- 2) Tracking tags issued to AI-only crawlers, and later reuse of those tags
CREATE TABLE IF NOT EXISTS edge_ref_tags (
  tag TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  bot TEXT NOT NULL,
  kind TEXT,                    -- 'html' | 'agents_md'
  path TEXT
);
CREATE INDEX IF NOT EXISTS idx_edge_ref_tags_ts ON edge_ref_tags(ts);

CREATE TABLE IF NOT EXISTS edge_ref_reuse (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  tag TEXT NOT NULL,
  issued_bot TEXT,
  issued_ts INTEGER,
  by_bot TEXT,                  -- NULL = no bot UA (human or unknown client)
  same_bot INTEGER DEFAULT 0,   -- 1 = the crawler that got the tag followed its own link
  path TEXT,
  referer_host TEXT,
  ai_source TEXT                -- referer host mapped to an AI assistant, if any
);
CREATE INDEX IF NOT EXISTS idx_edge_ref_reuse_ts ON edge_ref_reuse(ts);

-- 3) Human visits referred by AI assistants: aggregates per UTC hour, source, landing path, via
CREATE TABLE IF NOT EXISTS ai_referrals (
  hour TEXT NOT NULL,           -- 'YYYY-MM-DDTHH' UTC
  source TEXT NOT NULL,
  path TEXT NOT NULL,
  via TEXT NOT NULL,            -- 'referer' | 'utm'
  n INTEGER NOT NULL DEFAULT 0,
  last_ts INTEGER,
  PRIMARY KEY (hour, source, path, via)
);

-- Per-kind daily write caps (free-tier D1 quota guard)
CREATE TABLE IF NOT EXISTS edge_event_daily (
  day TEXT NOT NULL,
  kind TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, kind)
);
