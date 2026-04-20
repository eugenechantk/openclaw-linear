import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { initializeLinearSchema } from "../src/schema.js";

const TMP_DIR = join(import.meta.dirname ?? __dirname, "../.test-tmp-schema");
const DB_PATH = join(TMP_DIR, "linear.sqlite");

beforeEach(() => {
  mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

describe("canonical SQLite schema", () => {
  it("creates all Linear integration tables", () => {
    const db = new DatabaseSync(DB_PATH);
    initializeLinearSchema(db);

    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[];

    expect(rows.map((row) => row.name)).toEqual([
      "codex_runs",
      "issue_events",
      "issue_work",
      "normalized_events",
      "sqlite_sequence",
      "webhook_events",
    ]);
    db.close();
  });

  it("creates expanded issue work record columns", () => {
    const db = new DatabaseSync(DB_PATH);
    initializeLinearSchema(db);

    const columns = db
      .prepare("PRAGMA table_info(issue_work)")
      .all() as { name: string }[];

    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "linear_issue_uuid",
        "session_key",
        "codex_thread_id",
        "active_codex_run_id",
        "workspace",
        "work_status",
        "current_intent",
        "last_processed_event_time",
        "last_processed_comment_id",
        "last_human_comment_id",
        "last_openclaw_comment_id",
        "pending_follow_up_comment_ids",
        "pending_follow_up_count",
        "lease_owner",
        "lease_expires_at",
      ]),
    );
    db.close();
  });

  it("creates Codex run record columns", () => {
    const db = new DatabaseSync(DB_PATH);
    initializeLinearSchema(db);

    const columns = db
      .prepare("PRAGMA table_info(codex_runs)")
      .all() as { name: string }[];

    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "run_id",
        "issue_id",
        "codex_thread_id",
        "wrapper_pid",
        "codex_pid",
        "workdir",
        "status",
        "started_at",
        "finished_at",
        "exit_code",
        "last_visible_assistant_text_at",
        "prompt_preview",
      ]),
    );
    db.close();
  });
});
