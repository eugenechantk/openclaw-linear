import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { IssueWorkStore } from "../src/issue-work-store.js";
import type { EnqueueEntry } from "../src/work-queue.js";

const TMP_DIR = join(import.meta.dirname ?? __dirname, "../.test-tmp-issue-work");
const DB_PATH = join(TMP_DIR, "issue-work.sqlite");

function entry(
  id: string,
  issueId: string,
  event: string,
  summary = `${issueId}: Test issue`,
  issuePriority = 3,
): EnqueueEntry {
  return { id, issueId, event, summary, issuePriority };
}

beforeEach(() => {
  mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

describe("IssueWorkStore", () => {
  it("creates one pending work item per issue", async () => {
    const store = new IssueWorkStore(DB_PATH);

    expect(await store.enqueue([
      entry("EUG-55", "EUG-55", "issue.assigned"),
      entry("comment-1", "EUG-55", "comment.mention"),
    ])).toBe(1);

    const items = await store.peek();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      issueId: "EUG-55",
      status: "pending",
      priority: 0,
    });
  });

  it("dedupes exact events durably", async () => {
    const store = new IssueWorkStore(DB_PATH);
    const first = await store.enqueue([entry("comment-1", "EUG-55", "comment.mention")]);
    const second = await store.enqueue([entry("comment-1", "EUG-55", "comment.mention")]);

    expect(first).toBe(1);
    expect(second).toBe(0);
    expect(await store.peek()).toHaveLength(1);
  });

  it("ignores comment events at or before the processed event cursor", async () => {
    const store = new IssueWorkStore(DB_PATH);
    await store.enqueue([{
      ...entry("comment-1", "EUG-55", "comment.mention"),
      createdAt: "2026-04-19T00:01:00.000Z",
    }]);
    await store.claim("EUG-55");

    expect(await store.complete("EUG-55")).toBe(true);
    expect(store.getWork("EUG-55")).toMatchObject({
      workStatus: "in_review",
      lastProcessedCommentId: "comment-1",
      lastProcessedEventTime: "2026-04-19T00:01:00.000Z",
    });

    expect(await store.enqueue([{
      ...entry("comment-old", "EUG-55", "comment.mention"),
      createdAt: "2026-04-19T00:00:59.000Z",
    }])).toBe(0);
    expect(await store.enqueue([{
      ...entry("comment-1", "EUG-55", "comment.mention"),
      createdAt: "2026-04-19T00:01:00.000Z",
    }])).toBe(0);
    expect(await store.peek()).toHaveLength(0);

    expect(await store.enqueue([{
      ...entry("comment-2", "EUG-55", "comment.mention"),
      createdAt: "2026-04-19T00:02:00.000Z",
    }])).toBe(1);
    expect(await store.peek()).toHaveLength(1);
  });

  it("returns one dispatchable issue when a new event updates an existing pending issue", async () => {
    const store = new IssueWorkStore(DB_PATH);
    expect(await store.enqueue([entry("EUG-55", "EUG-55", "issue.assigned")])).toBe(1);

    expect(await store.enqueue([entry("comment-1", "EUG-55", "comment.mention")])).toBe(1);

    const pending = await store.peek();
    expect(pending).toHaveLength(1);
    expect(store.getWork("EUG-55")).toMatchObject({
      status: "pending",
      workStatus: "pending",
      currentIntent: "mention",
      lastHumanCommentId: "comment-1",
    });
  });

  it("stores follow-up comments while issue work is in progress without dispatching immediately", async () => {
    const store = new IssueWorkStore(DB_PATH);
    await store.enqueue([entry("EUG-55", "EUG-55", "issue.assigned")]);

    const claimed = await store.claim("EUG-55");
    expect(claimed).toMatchObject({
      issueId: "EUG-55",
      status: "in_progress",
      leaseOwner: "issue-session:EUG-55",
    });

    expect(await store.enqueue([entry("comment-1", "EUG-55", "comment.mention")])).toBe(0);
    expect(await store.peek()).toHaveLength(0);
    expect(store.getWork("EUG-55")).toMatchObject({
      workStatus: "running",
      pendingFollowUpCommentIds: ["comment-1"],
      pendingFollowUpCount: 1,
    });

    expect(await store.complete("EUG-55")).toBe(true);

    const pending = await store.peek();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      id: "comment-1",
      issueId: "EUG-55",
      event: "mention",
      status: "pending",
      priority: 0,
    });
    expect(store.getWork("EUG-55")).toMatchObject({
      workStatus: "pending",
      currentIntent: "mention",
      lastProcessedCommentId: null,
      pendingFollowUpCommentIds: [],
      pendingFollowUpCount: 0,
    });
  });

  it("keeps completed issue work as an in-review issue record when there are no pending follow-ups", async () => {
    const store = new IssueWorkStore(DB_PATH);
    await store.enqueue([entry("EUG-55", "EUG-55", "issue.assigned")]);
    await store.claim("EUG-55");

    expect(await store.complete("EUG-55")).toBe(true);
    expect(await store.peek()).toHaveLength(0);
    expect(store.getWork("EUG-55")).toMatchObject({
      issueId: "EUG-55",
      workStatus: "in_review",
      activeEventKeys: [],
      pendingEventKeys: [],
    });
  });

  it("does not mark issue work in review while a Codex run is still active", async () => {
    const store = new IssueWorkStore(DB_PATH);
    await store.enqueue([entry("EUG-55", "EUG-55", "issue.assigned")]);
    await store.claim("EUG-55");
    store.setActiveCodexRun("EUG-55", "run-1");
    store.setWorkStatus("EUG-55", "running");

    expect(await store.complete("EUG-55")).toBe(false);
    expect(store.getWork("EUG-55")).toMatchObject({
      issueId: "EUG-55",
      status: "in_progress",
      workStatus: "running",
      activeCodexRunId: "run-1",
    });
  });

  it("marks issue work in review after the active Codex run exits", async () => {
    const store = new IssueWorkStore(DB_PATH);
    await store.enqueue([entry("EUG-55", "EUG-55", "issue.assigned")]);
    await store.claim("EUG-55");
    store.setActiveCodexRun("EUG-55", "run-1");
    store.setWorkStatus("EUG-55", "running");

    const result = store.completeIssueWork("EUG-55", { activeRunStatus: "exited" });

    expect(result).toMatchObject({
      completed: true,
      issueId: "EUG-55",
      transition: "in_review",
      activeCodexRunId: "run-1",
    });
    expect(store.getWork("EUG-55")).toMatchObject({
      issueId: "EUG-55",
      status: "pending",
      workStatus: "in_review",
      activeCodexRunId: null,
      activeEventKeys: [],
      pendingEventKeys: [],
    });
  });

  it("blocks issue work after the active Codex run fails", async () => {
    const store = new IssueWorkStore(DB_PATH);
    await store.enqueue([entry("EUG-55", "EUG-55", "issue.assigned")]);
    await store.claim("EUG-55");
    store.setActiveCodexRun("EUG-55", "run-1");
    store.setWorkStatus("EUG-55", "running");

    const result = store.completeIssueWork("EUG-55", { activeRunStatus: "failed" });

    expect(result).toMatchObject({
      completed: true,
      issueId: "EUG-55",
      transition: "blocked",
      activeCodexRunId: "run-1",
    });
    expect(store.getWork("EUG-55")).toMatchObject({
      issueId: "EUG-55",
      status: "pending",
      workStatus: "blocked",
      activeCodexRunId: null,
    });
  });

  it("does not recover freshly leased in-progress work after restart", async () => {
    const store = new IssueWorkStore(DB_PATH);
    await store.enqueue([entry("EUG-55", "EUG-55", "issue.assigned")]);
    await store.claim("EUG-55");

    const restarted = new IssueWorkStore(DB_PATH);
    expect(await restarted.recover()).toBe(0);
    expect(await restarted.peek()).toHaveLength(0);
    expect(restarted.getWork("EUG-55")).toMatchObject({
      status: "in_progress",
      workStatus: "running",
      leaseOwner: "issue-session:EUG-55",
    });
  });

  it("does not recover a fresh unleased in-progress row when startup recovery is age-gated", async () => {
    const store = new IssueWorkStore(DB_PATH);
    await store.enqueue([entry("EUG-55", "EUG-55", "issue.assigned")]);
    await store.claim("EUG-55");

    const db = new DatabaseSync(DB_PATH);
    db.prepare(`
      UPDATE issue_work
      SET lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = '2026-04-19T00:04:00.000Z'
      WHERE issue_id = 'EUG-55'
    `).run();
    db.close();

    expect(store.recoverExpiredLeases(new Date("2026-04-19T00:05:00.000Z"), {
      includeUnleased: true,
      unleasedOlderThanMs: 300_000,
    })).toBe(0);
    expect(store.getWork("EUG-55")).toMatchObject({
      status: "in_progress",
      workStatus: "running",
    });
  });

  it("recovers an old unleased in-progress row during startup recovery", async () => {
    const store = new IssueWorkStore(DB_PATH);
    await store.enqueue([entry("EUG-55", "EUG-55", "issue.assigned")]);
    await store.claim("EUG-55");

    const db = new DatabaseSync(DB_PATH);
    db.prepare(`
      UPDATE issue_work
      SET lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = '2026-04-19T00:00:00.000Z'
      WHERE issue_id = 'EUG-55'
    `).run();
    db.close();

    expect(store.recoverExpiredLeases(new Date("2026-04-19T00:05:01.000Z"), {
      includeUnleased: true,
      unleasedOlderThanMs: 300_000,
    })).toBe(1);
    expect(store.getWork("EUG-55")).toMatchObject({
      status: "pending",
      workStatus: "pending",
    });
  });

  it("releases an issue-session claim after dispatch fails", async () => {
    const store = new IssueWorkStore(DB_PATH);
    await store.enqueue([entry("EUG-55", "EUG-55", "issue.assigned")]);
    const claimed = await store.claim("EUG-55");

    expect(store.releaseClaim("EUG-55", claimed?.leaseOwner)).toBe(true);
    expect(await store.peek()).toHaveLength(1);
    expect(store.getWork("EUG-55")).toMatchObject({
      status: "pending",
      workStatus: "pending",
      leaseOwner: null,
      leaseExpiresAt: null,
    });
  });

  it("does not release a claim that has already been taken over by a Codex run", async () => {
    const store = new IssueWorkStore(DB_PATH);
    await store.enqueue([entry("EUG-55", "EUG-55", "issue.assigned")]);
    const claimed = await store.claim("EUG-55");

    const db = new DatabaseSync(DB_PATH);
    db.prepare(`
      INSERT INTO codex_runs (
        run_id, issue_id, wrapper_pid, codex_pid, workdir, status, started_at
      ) VALUES ('run-live', 'EUG-55', ?, NULL, '/tmp/work', 'running', '2026-04-19T00:00:00.000Z')
    `).run(process.pid);
    db.prepare(`
      UPDATE issue_work
      SET active_codex_run_id = 'run-live',
          lease_owner = 'codex-run:run-live',
          lease_expires_at = '2026-04-19T00:10:00.000Z'
      WHERE issue_id = 'EUG-55'
    `).run();
    db.close();

    expect(store.releaseClaim("EUG-55", claimed?.leaseOwner)).toBe(false);
    expect(store.getWork("EUG-55")).toMatchObject({
      status: "in_progress",
      workStatus: "running",
      activeCodexRunId: "run-live",
      leaseOwner: "codex-run:run-live",
    });
  });

  it("extends an expired lease when the active Codex process is still alive", async () => {
    const store = new IssueWorkStore(DB_PATH);
    await store.enqueue([entry("EUG-55", "EUG-55", "issue.assigned")]);
    await store.claim("EUG-55");

    const db = new DatabaseSync(DB_PATH);
    db.prepare(`
      INSERT INTO codex_runs (
        run_id, issue_id, wrapper_pid, codex_pid, workdir, status, started_at
      ) VALUES ('run-live', 'EUG-55', ?, NULL, '/tmp/work', 'running', '2026-04-19T00:00:00.000Z')
    `).run(process.pid);
    db.prepare(`
      UPDATE issue_work
      SET active_codex_run_id = 'run-live',
          lease_owner = 'codex-run:run-live',
          lease_expires_at = '2026-04-19T00:00:00.000Z'
      WHERE issue_id = 'EUG-55'
    `).run();
    db.close();

    expect(store.recoverExpiredLeases(new Date("2026-04-19T00:05:00.000Z"))).toBe(0);
    expect(store.getWork("EUG-55")).toMatchObject({
      status: "in_progress",
      workStatus: "running",
      activeCodexRunId: "run-live",
    });
    expect(store.getWork("EUG-55")?.leaseExpiresAt).toBe("2026-04-19T00:10:00.000Z");
  });

  it("recovers an expired lease when the active Codex process is gone", async () => {
    const store = new IssueWorkStore(DB_PATH);
    await store.enqueue([entry("EUG-55", "EUG-55", "issue.assigned")]);
    await store.claim("EUG-55");

    const db = new DatabaseSync(DB_PATH);
    db.prepare(`
      INSERT INTO codex_runs (
        run_id, issue_id, wrapper_pid, codex_pid, workdir, status, started_at
      ) VALUES ('run-dead', 'EUG-55', 999999991, 999999992, '/tmp/work', 'running', '2026-04-19T00:00:00.000Z')
    `).run();
    db.prepare(`
      UPDATE issue_work
      SET active_codex_run_id = 'run-dead',
          lease_owner = 'codex-run:run-dead',
          lease_expires_at = '2026-04-19T00:00:00.000Z'
      WHERE issue_id = 'EUG-55'
    `).run();
    db.close();

    expect(store.recoverExpiredLeases(new Date("2026-04-19T00:05:00.000Z"))).toBe(1);
    expect(store.getWork("EUG-55")).toMatchObject({
      status: "pending",
      workStatus: "pending",
      activeCodexRunId: null,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    expect(store.getCodexRun("run-dead")).toMatchObject({
      status: "unknown",
      finishedAt: "2026-04-19T00:05:00.000Z",
    });
  });

  it("stores issue session and Codex continuity metadata on the issue work record", async () => {
    const store = new IssueWorkStore(DB_PATH);
    await store.enqueue([{
      ...entry("comment-1", "EUG-55", "comment.mention"),
      linearIssueUuid: "linear-uuid",
    }]);

    store.setSessionKey("EUG-55", "agent:main:linear:direct:issue:eug-55");
    store.setWorkspace("EUG-55", "/tmp/worktrees/EUG-55");
    store.setCodexThread("EUG-55", "thread-1");
    store.setActiveCodexRun("EUG-55", "run-1");
    store.setWorkStatus("EUG-55", "running");

    expect(store.getWork("EUG-55")).toMatchObject({
      linearIssueUuid: "linear-uuid",
      sessionKey: "agent:main:linear:direct:issue:eug-55",
      workspace: "/tmp/worktrees/EUG-55",
      codexThreadId: "thread-1",
      activeCodexRunId: "run-1",
      workStatus: "running",
      lastHumanCommentId: "comment-1",
    });

    store.setActiveCodexRun("EUG-55", null);
    store.setWorkStatus("EUG-55", "in_review");

    expect(store.getWork("EUG-55")).toMatchObject({
      activeCodexRunId: null,
      workStatus: "in_review",
    });
  });
});
