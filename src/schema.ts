import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

export function loadLinearSchemaSql(): string {
  return readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
}

export function initializeLinearSchema(db: DatabaseSync): void {
  db.exec(loadLinearSchemaSql());
  migrateIssueWorkSchema(db);
}

function migrateIssueWorkSchema(db: DatabaseSync): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(issue_work)").all() as { name: string }[])
      .map((column) => column.name),
  );

  const additions: Record<string, string> = {
    linear_issue_uuid: "ALTER TABLE issue_work ADD COLUMN linear_issue_uuid TEXT",
    session_key: "ALTER TABLE issue_work ADD COLUMN session_key TEXT",
    codex_thread_id: "ALTER TABLE issue_work ADD COLUMN codex_thread_id TEXT",
    active_codex_run_id: "ALTER TABLE issue_work ADD COLUMN active_codex_run_id TEXT",
    workspace: "ALTER TABLE issue_work ADD COLUMN workspace TEXT",
    work_status: "ALTER TABLE issue_work ADD COLUMN work_status TEXT NOT NULL DEFAULT 'pending'",
    current_intent: "ALTER TABLE issue_work ADD COLUMN current_intent TEXT",
    last_processed_event_time: "ALTER TABLE issue_work ADD COLUMN last_processed_event_time TEXT",
    last_processed_comment_id: "ALTER TABLE issue_work ADD COLUMN last_processed_comment_id TEXT",
    last_human_comment_id: "ALTER TABLE issue_work ADD COLUMN last_human_comment_id TEXT",
    last_openclaw_comment_id: "ALTER TABLE issue_work ADD COLUMN last_openclaw_comment_id TEXT",
    pending_follow_up_comment_ids: "ALTER TABLE issue_work ADD COLUMN pending_follow_up_comment_ids TEXT NOT NULL DEFAULT '[]'",
    pending_follow_up_count: "ALTER TABLE issue_work ADD COLUMN pending_follow_up_count INTEGER NOT NULL DEFAULT 0",
    lease_owner: "ALTER TABLE issue_work ADD COLUMN lease_owner TEXT",
    lease_expires_at: "ALTER TABLE issue_work ADD COLUMN lease_expires_at TEXT",
  };

  for (const [column, sql] of Object.entries(additions)) {
    if (!columns.has(column)) db.exec(sql);
  }
}
