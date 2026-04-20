PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS webhook_events (
  delivery_id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  type TEXT NOT NULL,
  issue_id TEXT,
  comment_id TEXT,
  actor_id TEXT,
  created_at TEXT,
  received_at TEXT NOT NULL,
  raw_body TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS webhook_events_issue_idx
  ON webhook_events(issue_id);

CREATE INDEX IF NOT EXISTS webhook_events_received_idx
  ON webhook_events(received_at);

CREATE TABLE IF NOT EXISTS normalized_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id TEXT,
  issue_id TEXT,
  identifier TEXT,
  comment_id TEXT,
  actor_id TEXT,
  intent TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('process', 'ignore')),
  reason TEXT,
  created_at TEXT,
  recorded_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS normalized_events_delivery_idx
  ON normalized_events(delivery_id);

CREATE INDEX IF NOT EXISTS normalized_events_issue_idx
  ON normalized_events(issue_id);

CREATE INDEX IF NOT EXISTS normalized_events_decision_idx
  ON normalized_events(decision);

CREATE TABLE IF NOT EXISTS issue_events (
  event_key TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL,
  event TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS issue_work (
  issue_id TEXT PRIMARY KEY,
  linear_issue_uuid TEXT,
  session_key TEXT,
  codex_thread_id TEXT,
  active_codex_run_id TEXT,
  workspace TEXT,
  work_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (work_status IN ('idle', 'pending', 'running', 'in_review', 'blocked', 'done')),
  current_intent TEXT,
  last_processed_event_time TEXT,
  last_processed_comment_id TEXT,
  last_human_comment_id TEXT,
  last_openclaw_comment_id TEXT,
  pending_follow_up_comment_ids TEXT NOT NULL DEFAULT '[]',
  pending_follow_up_count INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires_at TEXT,
  id TEXT NOT NULL,
  event TEXT NOT NULL,
  summary TEXT NOT NULL,
  priority INTEGER NOT NULL,
  added_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'in_progress')),
  active_event_keys TEXT NOT NULL,
  pending_event_keys TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS codex_runs (
  run_id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL,
  codex_thread_id TEXT,
  wrapper_pid INTEGER,
  codex_pid INTEGER,
  workdir TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('running', 'exited', 'failed', 'timed_out', 'cancelled', 'unknown')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  exit_code INTEGER,
  last_visible_assistant_text_at TEXT,
  prompt_preview TEXT
);

CREATE INDEX IF NOT EXISTS codex_runs_issue_idx
  ON codex_runs(issue_id);

CREATE INDEX IF NOT EXISTS codex_runs_thread_idx
  ON codex_runs(codex_thread_id);

CREATE INDEX IF NOT EXISTS codex_runs_status_idx
  ON codex_runs(status);
