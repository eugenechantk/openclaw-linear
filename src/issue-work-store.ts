import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { initializeLinearSchema } from "./schema.js";
import { QUEUE_EVENT, type EnqueueEntry, type QueueItem } from "./work-queue.js";

export type IssueWorkRecord = QueueItem & {
  updatedAt: string;
  activeEventKeys: string[];
  pendingEventKeys: string[];
};

type IssueWorkStatus = "idle" | "pending" | "running" | "in_review" | "blocked" | "done";
export type CodexRunStatus = "running" | "exited" | "failed" | "timed_out" | "cancelled" | "unknown";

export type CodexRunRecord = {
  runId: string;
  issueId: string;
  codexThreadId: string | null;
  wrapperPid: number | null;
  codexPid: number | null;
  workdir: string;
  status: CodexRunStatus;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  lastVisibleAssistantTextAt: string | null;
  promptPreview: string | null;
};

type CodexRunRow = {
  run_id: string;
  issue_id: string;
  codex_thread_id: string | null;
  wrapper_pid: number | null;
  codex_pid: number | null;
  workdir: string;
  status: CodexRunStatus;
  started_at: string;
  finished_at: string | null;
  exit_code: number | null;
  last_visible_assistant_text_at: string | null;
  prompt_preview: string | null;
};

export type IssueWorkCompletionResult = {
  completed: boolean;
  issueId: string;
  transition:
    | "not_found"
    | "codex_still_running"
    | "in_review"
    | "pending_followup"
    | "blocked";
  activeCodexRunId?: string | null;
};

const REMOVAL_EVENTS = new Set([
  "issue.unassigned",
  "issue.reassigned",
  "issue.removed",
  "issue.state_removed",
]);

function mapPriority(linearPriority: number): number {
  return linearPriority === 0 ? 5 : linearPriority;
}

function queuePriority(event: string, issuePriority: number): number {
  return event === "mention" ? 0 : mapPriority(issuePriority);
}

function nowIso(): string {
  return new Date().toISOString();
}

function isoFromNow(ttlMs: number): string {
  return new Date(Date.now() + ttlMs).toISOString();
}

function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function serializeJsonArray(values: string[]): string {
  return JSON.stringify([...new Set(values)]);
}

function eventKey(entry: EnqueueEntry, queueEvent: string): string {
  return `${entry.id}:${queueEvent}`;
}

function eventIdFromKey(key: string): string {
  const idx = key.lastIndexOf(":");
  return idx === -1 ? key : key.slice(0, idx);
}

function eventTypeFromKey(key: string): string {
  const idx = key.lastIndexOf(":");
  return idx === -1 ? "" : key.slice(idx + 1);
}

function lastMentionIdFromKeys(keys: string[]): string | null {
  const key = [...keys].reverse().find((item) => eventTypeFromKey(item) === "mention");
  return key ? eventIdFromKey(key) : null;
}

type IssueWorkRow = {
  issue_id: string;
  linear_issue_uuid: string | null;
  session_key: string | null;
  codex_thread_id: string | null;
  active_codex_run_id: string | null;
  workspace: string | null;
  work_status: string | null;
  current_intent: string | null;
  last_processed_event_time: string | null;
  last_processed_comment_id: string | null;
  last_human_comment_id: string | null;
  last_openclaw_comment_id: string | null;
  pending_follow_up_comment_ids: string;
  pending_follow_up_count: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  id: string;
  event: string;
  summary: string;
  priority: number;
  added_at: string;
  updated_at: string;
  status: "pending" | "in_progress";
  active_event_keys: string;
  pending_event_keys: string;
};

export class IssueWorkStore {
  private readonly db: DatabaseSync;

  constructor(private readonly path: string) {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(path);
    this.initialize();
  }

  private initialize(): void {
    initializeLinearSchema(this.db);
  }

  private getRow(issueId: string): IssueWorkRow | undefined {
    return this.db
      .prepare("SELECT * FROM issue_work WHERE issue_id = ?")
      .get(issueId) as IssueWorkRow | undefined;
  }

  private rowToItem(row: IssueWorkRow): QueueItem {
    return {
      id: row.id,
      issueId: row.issue_id,
      event: row.event,
      summary: row.summary,
      priority: row.priority,
      addedAt: row.added_at,
      status: row.status,
      linearIssueUuid: row.linear_issue_uuid,
      sessionKey: row.session_key,
      codexThreadId: row.codex_thread_id,
      activeCodexRunId: row.active_codex_run_id,
      workspace: row.workspace,
      workStatus: row.work_status,
      currentIntent: row.current_intent,
      lastProcessedEventTime: row.last_processed_event_time,
      lastProcessedCommentId: row.last_processed_comment_id,
      lastHumanCommentId: row.last_human_comment_id,
      lastOpenClawCommentId: row.last_openclaw_comment_id,
      pendingFollowUpCommentIds: parseJsonArray(row.pending_follow_up_comment_ids),
      pendingFollowUpCount: row.pending_follow_up_count,
      leaseOwner: row.lease_owner,
      leaseExpiresAt: row.lease_expires_at,
    };
  }

  private rowToRecord(row: IssueWorkRow): IssueWorkRecord {
    return {
      ...this.rowToItem(row),
      updatedAt: row.updated_at,
      activeEventKeys: parseJsonArray(row.active_event_keys),
      pendingEventKeys: parseJsonArray(row.pending_event_keys),
    };
  }

  private rowToCodexRun(row: CodexRunRow): CodexRunRecord {
    return {
      runId: row.run_id,
      issueId: row.issue_id,
      codexThreadId: row.codex_thread_id,
      wrapperPid: row.wrapper_pid,
      codexPid: row.codex_pid,
      workdir: row.workdir,
      status: row.status,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      exitCode: row.exit_code,
      lastVisibleAssistantTextAt: row.last_visible_assistant_text_at,
      promptPreview: row.prompt_preview,
    };
  }

  getWork(issueId: string): IssueWorkRecord | null {
    const row = this.getRow(issueId);
    return row ? this.rowToRecord(row) : null;
  }

  getCodexRun(runId: string): CodexRunRecord | null {
    const row = this.db
      .prepare("SELECT * FROM codex_runs WHERE run_id = ?")
      .get(runId) as CodexRunRow | undefined;
    if (!row) return null;

    return this.rowToCodexRun(row);
  }

  listCodexRuns(issueId: string, limit = 10): CodexRunRecord[] {
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const rows = this.db
      .prepare(`
        SELECT * FROM codex_runs
        WHERE issue_id = ?
        ORDER BY started_at DESC
        LIMIT ?
      `)
      .all(issueId, safeLimit) as CodexRunRow[];
    return rows.map((row) => this.rowToCodexRun(row));
  }

  private eventTimeForKeys(keys: string[], fallback: string): string {
    if (keys.length === 0) return fallback;
    const placeholders = keys.map(() => "?").join(", ");
    const row = this.db
      .prepare(`SELECT MAX(created_at) AS created_at FROM issue_events WHERE event_key IN (${placeholders})`)
      .get(...keys) as { created_at?: string | null } | undefined;
    return row?.created_at ?? fallback;
  }

  private isAlreadyProcessed(row: IssueWorkRow, entry: EnqueueEntry, queueEvent: string, eventCreatedAt: string): boolean {
    if (queueEvent !== "mention") return false;
    if (row.last_processed_comment_id && row.last_processed_comment_id === entry.id) return true;
    if (row.last_processed_event_time && eventCreatedAt <= row.last_processed_event_time) return true;
    return false;
  }

  setSessionKey(issueId: string, sessionKey: string): void {
    this.db
      .prepare("UPDATE issue_work SET session_key = ?, updated_at = ? WHERE issue_id = ?")
      .run(sessionKey, nowIso(), issueId);
  }

  setWorkspace(issueId: string, workspace: string): void {
    this.db
      .prepare("UPDATE issue_work SET workspace = ?, updated_at = ? WHERE issue_id = ?")
      .run(workspace, nowIso(), issueId);
  }

  setCodexThread(issueId: string, codexThreadId: string): void {
    this.db
      .prepare("UPDATE issue_work SET codex_thread_id = ?, updated_at = ? WHERE issue_id = ?")
      .run(codexThreadId, nowIso(), issueId);
  }

  setActiveCodexRun(issueId: string, codexRunId: string | null): void {
    this.db
      .prepare("UPDATE issue_work SET active_codex_run_id = ?, updated_at = ? WHERE issue_id = ?")
      .run(codexRunId, nowIso(), issueId);
  }

  setWorkStatus(issueId: string, workStatus: IssueWorkStatus): void {
    this.db
      .prepare("UPDATE issue_work SET work_status = ?, updated_at = ? WHERE issue_id = ?")
      .run(workStatus, nowIso(), issueId);
  }

  refreshLease(issueId: string, owner: string, ttlMs = 300_000): boolean {
    const timestamp = nowIso();
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    const result = this.db
      .prepare(`
        UPDATE issue_work
        SET lease_owner = ?, lease_expires_at = ?, updated_at = ?
        WHERE issue_id = ? AND lease_owner = ?
      `)
      .run(owner, expiresAt, timestamp, issueId, owner);
    return Number(result.changes) > 0;
  }

  async enqueue(entries: EnqueueEntry[]): Promise<number> {
    if (entries.length === 0) return 0;

    const dispatchableIssueIds = new Set<string>();
    const timestamp = nowIso();

    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const entry of entries) {
        if (REMOVAL_EVENTS.has(entry.event)) {
          this.db.prepare("DELETE FROM issue_work WHERE issue_id = ?").run(entry.issueId ?? entry.id);
          continue;
        }

        if (entry.event === "issue.priority_changed") {
          this.db
            .prepare("UPDATE issue_work SET priority = ?, updated_at = ? WHERE issue_id = ?")
            .run(mapPriority(entry.issuePriority), timestamp, entry.issueId ?? entry.id);
          continue;
        }

        const queueEvent = QUEUE_EVENT[entry.event];
        if (!queueEvent) continue;

        const issueId = entry.issueId ?? entry.id;
        const priority = queuePriority(queueEvent, entry.issuePriority);
        const row = this.getRow(issueId);
        const eventCreatedAt = entry.createdAt ?? timestamp;

        if (row && this.isAlreadyProcessed(row, entry, queueEvent, eventCreatedAt)) {
          continue;
        }

        const key = eventKey(entry, queueEvent);
        const inserted = this.db
          .prepare("INSERT OR IGNORE INTO issue_events (event_key, issue_id, event, created_at) VALUES (?, ?, ?, ?)")
          .run(key, issueId, queueEvent, eventCreatedAt);
        if (inserted.changes === 0) continue;

        if (!row) {
          this.db
            .prepare(`
              INSERT INTO issue_work (
                issue_id, linear_issue_uuid, id, event, summary, priority,
                added_at, updated_at, status, work_status, current_intent,
                active_event_keys, pending_event_keys, pending_follow_up_comment_ids,
                pending_follow_up_count, last_human_comment_id
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'pending', ?, ?, ?, ?, ?, ?)
            `)
            .run(
              issueId,
              entry.linearIssueUuid ?? null,
              entry.id,
              queueEvent,
              entry.summary,
              priority,
              timestamp,
              timestamp,
              queueEvent,
              serializeJsonArray([key]),
              serializeJsonArray([]),
              serializeJsonArray([]),
              0,
              queueEvent === "mention" ? entry.id : null,
            );
          dispatchableIssueIds.add(issueId);
          continue;
        }

        if (row.status === "in_progress") {
          const pendingKeys = parseJsonArray(row.pending_event_keys);
          pendingKeys.push(key);
          const pendingFollowUpCommentIds = parseJsonArray(row.pending_follow_up_comment_ids);
          if (queueEvent === "mention") pendingFollowUpCommentIds.push(entry.id);
          this.db
            .prepare(`
              UPDATE issue_work
              SET pending_event_keys = ?,
                  pending_follow_up_comment_ids = ?,
                  pending_follow_up_count = ?,
                  last_human_comment_id = COALESCE(?, last_human_comment_id),
                  linear_issue_uuid = COALESCE(linear_issue_uuid, ?),
                  updated_at = ?
              WHERE issue_id = ?
            `)
            .run(
              serializeJsonArray(pendingKeys),
              serializeJsonArray(pendingFollowUpCommentIds),
              pendingFollowUpCommentIds.length,
              queueEvent === "mention" ? entry.id : null,
              entry.linearIssueUuid ?? null,
              timestamp,
              issueId,
            );
          continue;
        }

        const activeKeys = parseJsonArray(row.active_event_keys);
        activeKeys.push(key);
        this.db
          .prepare(`
            UPDATE issue_work
            SET active_event_keys = ?,
                summary = ?,
                priority = MIN(priority, ?),
                current_intent = ?,
                work_status = 'pending',
                last_human_comment_id = COALESCE(?, last_human_comment_id),
                linear_issue_uuid = COALESCE(linear_issue_uuid, ?),
                updated_at = ?
            WHERE issue_id = ?
          `)
          .run(
            serializeJsonArray(activeKeys),
            entry.summary,
            priority,
            queueEvent,
            queueEvent === "mention" ? entry.id : null,
            entry.linearIssueUuid ?? null,
            timestamp,
            issueId,
          );
        if (row.status === "pending" && row.work_status !== "running") {
          dispatchableIssueIds.add(issueId);
        }
      }

      this.db.exec("COMMIT");
      return dispatchableIssueIds.size;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  async peek(): Promise<QueueItem[]> {
    const rows = this.db
      .prepare("SELECT * FROM issue_work WHERE status = 'pending' AND work_status = 'pending' ORDER BY priority ASC, added_at ASC")
      .all() as IssueWorkRow[];
    return rows.map((row) => this.rowToItem(row));
  }

  async pop(): Promise<QueueItem | null> {
    const rows = await this.peek();
    const item = rows[0];
    if (!item) return null;
    return this.claim(item.issueId);
  }

  async claim(issueId: string): Promise<QueueItem | null> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.getRow(issueId);
      if (!row || row.status !== "pending" || row.work_status !== "pending") {
        this.db.exec("COMMIT");
        return null;
      }

      const timestamp = nowIso();
      const leaseOwner = `issue-session:${issueId}`;
      const leaseExpiresAt = isoFromNow(300_000);
      this.db
        .prepare(`
          UPDATE issue_work
          SET status = 'in_progress',
              work_status = 'running',
              lease_owner = ?,
              lease_expires_at = ?,
              updated_at = ?
          WHERE issue_id = ?
        `)
        .run(leaseOwner, leaseExpiresAt, timestamp, issueId);
      this.db.exec("COMMIT");
      return {
        ...this.rowToItem(row),
        status: "in_progress",
        workStatus: "running",
        leaseOwner,
        leaseExpiresAt,
      };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  releaseClaim(issueId: string, expectedLeaseOwner?: string | null): boolean {
    const timestamp = nowIso();
    const result = expectedLeaseOwner
      ? this.db
        .prepare(`
          UPDATE issue_work
          SET status = 'pending',
              work_status = 'pending',
              lease_owner = NULL,
              lease_expires_at = NULL,
              updated_at = ?
          WHERE issue_id = ?
            AND status = 'in_progress'
            AND work_status = 'running'
            AND lease_owner = ?
            AND active_codex_run_id IS NULL
        `)
        .run(timestamp, issueId, expectedLeaseOwner)
      : this.db
        .prepare(`
          UPDATE issue_work
          SET status = 'pending',
              work_status = 'pending',
              lease_owner = NULL,
              lease_expires_at = NULL,
              updated_at = ?
          WHERE issue_id = ?
            AND status = 'in_progress'
            AND work_status = 'running'
            AND active_codex_run_id IS NULL
        `)
        .run(timestamp, issueId);
    return Number(result.changes) > 0;
  }

  async drain(): Promise<QueueItem[]> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db
        .prepare("SELECT * FROM issue_work WHERE status = 'pending' AND work_status = 'pending' ORDER BY priority ASC, added_at ASC")
        .all() as IssueWorkRow[];
      const timestamp = nowIso();
      for (const row of rows) {
        this.db
          .prepare(`
            UPDATE issue_work
            SET status = 'in_progress',
                work_status = 'running',
                lease_owner = ?,
                lease_expires_at = ?,
                updated_at = ?
            WHERE issue_id = ?
          `)
          .run(`issue-session:${row.issue_id}`, isoFromNow(300_000), timestamp, row.issue_id);
      }
      this.db.exec("COMMIT");
      return rows.map((row) => ({ ...this.rowToItem(row), status: "in_progress" }));
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  completeIssueWork(issueId: string, options: { activeRunStatus?: CodexRunStatus | null } = {}): IssueWorkCompletionResult {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.getRow(issueId);
      if (!row || row.status !== "in_progress") {
        this.db.exec("COMMIT");
        return {
          completed: false,
          issueId,
          transition: "not_found",
        };
      }

      const pendingKeys = parseJsonArray(row.pending_event_keys);
      const activeKeys = parseJsonArray(row.active_event_keys);
      const completedCommentId = lastMentionIdFromKeys(activeKeys);
      const timestamp = nowIso();
      const completedEventTime = this.eventTimeForKeys(activeKeys, timestamp);

      if (row.active_codex_run_id && row.work_status === "running") {
        const activeRunStatus = options.activeRunStatus ?? "running";
        if (activeRunStatus === "running") {
          this.db.exec("COMMIT");
          return {
            completed: false,
            issueId,
            transition: "codex_still_running",
            activeCodexRunId: row.active_codex_run_id,
          };
        }

        if (activeRunStatus !== "exited") {
          this.db
            .prepare(`
              UPDATE issue_work
              SET status = 'pending',
                  work_status = 'blocked',
                  active_codex_run_id = NULL,
                  lease_owner = NULL,
                  lease_expires_at = NULL,
                  last_processed_comment_id = COALESCE(?, last_processed_comment_id),
                  last_processed_event_time = ?,
                  updated_at = ?
              WHERE issue_id = ?
            `)
            .run(
              completedCommentId,
              completedEventTime,
              timestamp,
              issueId,
            );
          this.db.exec("COMMIT");
          return {
            completed: true,
            issueId,
            transition: "blocked",
            activeCodexRunId: row.active_codex_run_id,
          };
        }
      }

      if (pendingKeys.length === 0) {
        this.db
          .prepare(`
            UPDATE issue_work
            SET status = 'pending',
                work_status = 'in_review',
                active_codex_run_id = NULL,
                lease_owner = NULL,
                lease_expires_at = NULL,
                active_event_keys = '[]',
                pending_event_keys = '[]',
                pending_follow_up_comment_ids = '[]',
                pending_follow_up_count = 0,
                last_processed_comment_id = COALESCE(?, last_processed_comment_id),
                last_processed_event_time = ?,
                updated_at = ?
            WHERE issue_id = ?
          `)
          .run(
            completedCommentId,
            completedEventTime,
            timestamp,
            issueId,
          );
        this.db.exec("COMMIT");
        return {
          completed: true,
          issueId,
          transition: "in_review",
          activeCodexRunId: row.active_codex_run_id,
        };
      }

      const firstPendingKey = pendingKeys[0];
      const event = String(
        (this.db.prepare("SELECT event FROM issue_events WHERE event_key = ?").get(firstPendingKey) as { event?: string } | undefined)
          ?.event ?? row.event,
      );

      this.db
        .prepare(`
          UPDATE issue_work
          SET id = ?, event = ?, status = 'pending', active_event_keys = ?,
              pending_event_keys = ?, priority = ?, current_intent = ?,
              pending_follow_up_comment_ids = '[]', pending_follow_up_count = 0,
              work_status = 'pending',
              active_codex_run_id = NULL,
              lease_owner = NULL,
              lease_expires_at = NULL,
              last_processed_comment_id = COALESCE(?, last_processed_comment_id),
              last_processed_event_time = ?, updated_at = ?
          WHERE issue_id = ?
        `)
        .run(
          eventIdFromKey(firstPendingKey),
          event,
          serializeJsonArray(pendingKeys),
          serializeJsonArray([]),
          event === "mention" ? 0 : row.priority,
          event,
          completedCommentId,
          completedEventTime,
          timestamp,
          issueId,
        );
      this.db.exec("COMMIT");
      return {
        completed: true,
        issueId,
        transition: "pending_followup",
        activeCodexRunId: row.active_codex_run_id,
      };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  async complete(issueId: string): Promise<boolean> {
    return this.completeIssueWork(issueId).completed;
  }

  async recover(): Promise<number> {
    return this.recoverExpiredLeases(new Date(), { includeUnleased: true });
  }

  recoverExpiredLeases(
    now = new Date(),
    options: { includeUnleased?: boolean; leaseMs?: number; unleasedOlderThanMs?: number } = {},
  ): number {
    const timestamp = now.toISOString();
    const expiry = new Date(now.getTime() + (options.leaseMs ?? 300_000)).toISOString();
    const unleasedCutoff = new Date(now.getTime() - (options.unleasedOlderThanMs ?? 0)).toISOString();
    const rows = this.db
      .prepare(`
        SELECT * FROM issue_work
        WHERE status = 'in_progress'
          AND (
            lease_expires_at <= ?
            ${options.includeUnleased ? "OR (lease_expires_at IS NULL AND updated_at <= ?)" : ""}
          )
      `)
      .all(...(options.includeUnleased ? [timestamp, unleasedCutoff] : [timestamp])) as IssueWorkRow[];

    if (rows.length === 0) return 0;

    let recovered = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        const activeRun = row.active_codex_run_id ? this.getCodexRun(row.active_codex_run_id) : null;
        if (
          activeRun?.status === "running"
          && (this.processExists(activeRun.wrapperPid) || this.processExists(activeRun.codexPid))
        ) {
          this.db
            .prepare(`
              UPDATE issue_work
              SET lease_owner = COALESCE(lease_owner, ?),
                  lease_expires_at = ?,
                  updated_at = ?
              WHERE issue_id = ?
            `)
            .run(`codex-run:${activeRun.runId}`, expiry, timestamp, row.issue_id);
          continue;
        }

        if (activeRun?.status === "running") {
          this.db
            .prepare(`
              UPDATE codex_runs
              SET status = 'unknown',
                  finished_at = COALESCE(finished_at, ?)
              WHERE run_id = ? AND status = 'running'
            `)
            .run(timestamp, activeRun.runId);
        }

        const activeKeys = parseJsonArray(row.active_event_keys);
        const pendingKeys = parseJsonArray(row.pending_event_keys);
        const recoveredKeys = activeKeys.length > 0 ? [...activeKeys, ...pendingKeys] : pendingKeys;
        const firstKey = recoveredKeys[0] ?? row.id;
        const event = firstKey.includes(":")
          ? String(
            (this.db.prepare("SELECT event FROM issue_events WHERE event_key = ?").get(firstKey) as { event?: string } | undefined)
              ?.event ?? row.event,
          )
          : row.event;

        this.db
          .prepare(`
            UPDATE issue_work
            SET id = ?,
                event = ?,
                status = 'pending',
                work_status = 'pending',
                current_intent = ?,
                active_codex_run_id = NULL,
                lease_owner = NULL,
                lease_expires_at = NULL,
                active_event_keys = ?,
                pending_event_keys = '[]',
                pending_follow_up_comment_ids = '[]',
                pending_follow_up_count = 0,
                priority = CASE WHEN ? = 'mention' THEN 0 ELSE priority END,
                updated_at = ?
            WHERE issue_id = ?
          `)
          .run(
            eventIdFromKey(firstKey),
            event,
            event,
            serializeJsonArray(recoveredKeys),
            event,
            timestamp,
            row.issue_id,
          );
        recovered += 1;
      }
      this.db.exec("COMMIT");
      return recovered;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private processExists(pid: number | null): boolean {
    if (!pid || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "EPERM";
    }
  }
}
