import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RouterAction } from "../src/event-router.js";
import { IssueWorkDispatcher } from "../src/issue-work-dispatcher.js";
import { type CodexRunRecord, IssueWorkStore } from "../src/issue-work-store.js";

const TMP_DIR = join(import.meta.dirname ?? __dirname, "../.test-tmp-issue-work-dispatcher");
const DB_PATH = join(TMP_DIR, "issue-work-dispatcher.sqlite");

function action(overrides: Partial<RouterAction> = {}): RouterAction {
  return {
    type: "wake",
    agentId: "main",
    event: "issue.assigned",
    detail: "Assigned to issue EUG-55: Test issue",
    issueId: "linear-uuid",
    issueLabel: "EUG-55: Test issue",
    identifier: "EUG-55",
    issuePriority: 3,
    linearUserId: "openclaw-user",
    createdAt: "2026-04-19T00:00:00Z",
    ...overrides,
  };
}

function commentAction(id: string, overrides: Partial<RouterAction> = {}): RouterAction {
  return action({
    event: "comment.mention",
    detail: "New comment on issue EUG-55\n\n> Please retry.",
    commentId: id,
    commentBody: "Please retry.",
    createdAt: "2026-04-19T00:01:00Z",
    ...overrides,
  });
}

beforeEach(() => {
  mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

describe("IssueWorkDispatcher", () => {
  it("enqueues, claims, and dispatches actionable issue work", async () => {
    const store = new IssueWorkStore(DB_PATH);
    const dispatchIssueSession = vi.fn(async () => undefined);
    const dispatcher = new IssueWorkDispatcher({
      store,
      logger: { info: vi.fn(), error: vi.fn() },
      dispatchIssueSession,
    });

    const decision = await dispatcher.dispatchActions([action()]);

    expect(decision).toMatchObject({
      type: "dispatched",
      issueId: "EUG-55",
      item: { issueId: "EUG-55", status: "in_progress" },
    });
    expect(store.getWork("EUG-55")).toMatchObject({
      status: "in_progress",
      workStatus: "running",
    });
    expect(dispatchIssueSession).toHaveBeenCalledWith({
      issueId: "EUG-55",
      fallbackAgentId: "main",
      actions: [action()],
    });
  });

  it("assigns issue ownership before dispatching claimed work", async () => {
    const store = new IssueWorkStore(DB_PATH);
    const assignIssueOwner = vi.fn(async () => undefined);
    const dispatchIssueSession = vi.fn(async () => undefined);
    const dispatcher = new IssueWorkDispatcher({
      store,
      logger: { info: vi.fn(), error: vi.fn() },
      assignIssueOwner,
      dispatchIssueSession,
    });

    const decision = await dispatcher.dispatchActions([action()]);

    expect(decision).toMatchObject({
      type: "dispatched",
      issueId: "EUG-55",
    });
    expect(assignIssueOwner).toHaveBeenCalledWith("EUG-55");
    expect(dispatchIssueSession).toHaveBeenCalledWith({
      issueId: "EUG-55",
      fallbackAgentId: "main",
      actions: [action()],
    });
    expect(assignIssueOwner.mock.invocationCallOrder[0]).toBeLessThan(
      dispatchIssueSession.mock.invocationCallOrder[0],
    );
  });

  it("releases the claim and skips dispatch when issue ownership assignment fails", async () => {
    const store = new IssueWorkStore(DB_PATH);
    const assignIssueOwner = vi.fn(async () => {
      throw new Error("Linear unavailable");
    });
    const dispatchIssueSession = vi.fn(async () => undefined);
    const dispatcher = new IssueWorkDispatcher({
      store,
      logger: { info: vi.fn(), error: vi.fn() },
      assignIssueOwner,
      dispatchIssueSession,
    });

    const decision = await dispatcher.dispatchActions([action()]);

    expect(decision).toMatchObject({
      type: "not_dispatchable",
      issueId: "EUG-55",
      reason: "assignment_failed",
    });
    expect(dispatchIssueSession).not.toHaveBeenCalled();
    expect(store.getWork("EUG-55")).toMatchObject({
      status: "pending",
      workStatus: "pending",
      leaseOwner: null,
      leaseExpiresAt: null,
    });
  });

  it("does not dispatch duplicate actions", async () => {
    const store = new IssueWorkStore(DB_PATH);
    const dispatchIssueSession = vi.fn(async () => undefined);
    const dispatcher = new IssueWorkDispatcher({
      store,
      logger: { info: vi.fn(), error: vi.fn() },
      dispatchIssueSession,
    });

    await dispatcher.dispatchActions([action()]);
    const duplicate = await dispatcher.dispatchActions([action()]);

    expect(duplicate).toMatchObject({
      type: "not_dispatchable",
      issueId: "EUG-55",
      reason: "deduped_or_stored_pending_followup",
    });
    expect(dispatchIssueSession).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch stale comments at or before the processed cursor", async () => {
    const store = new IssueWorkStore(DB_PATH);
    const dispatchIssueSession = vi.fn(async () => undefined);
    const dispatcher = new IssueWorkDispatcher({
      store,
      logger: { info: vi.fn(), error: vi.fn() },
      dispatchIssueSession,
    });

    await dispatcher.dispatchActions([commentAction("comment-1")]);
    await store.complete("EUG-55");

    const stale = await dispatcher.dispatchActions([
      commentAction("comment-old", {
        createdAt: "2026-04-19T00:00:30Z",
      }),
    ]);

    expect(stale).toMatchObject({
      type: "not_dispatchable",
      issueId: "EUG-55",
      reason: "deduped_or_stored_pending_followup",
    });
    expect(dispatchIssueSession).toHaveBeenCalledTimes(1);
  });

  it("dispatches a new event added to an existing pending issue row", async () => {
    const store = new IssueWorkStore(DB_PATH);
    const dispatchIssueSession = vi.fn(async () => undefined);
    const dispatcher = new IssueWorkDispatcher({
      store,
      logger: { info: vi.fn(), error: vi.fn() },
      dispatchIssueSession,
    });

    await store.enqueue([action()].map((a) => ({
      id: a.commentId || a.identifier,
      issueId: a.identifier,
      linearIssueUuid: a.issueId,
      event: a.event,
      summary: a.issueLabel,
      issuePriority: a.issuePriority,
      commentBody: a.commentBody,
      createdAt: a.createdAt,
    })));

    const decision = await dispatcher.dispatchActions([commentAction("comment-1")]);

    expect(decision).toMatchObject({
      type: "dispatched",
      issueId: "EUG-55",
      item: { issueId: "EUG-55", status: "in_progress", event: "ticket" },
    });
    expect(store.getWork("EUG-55")).toMatchObject({
      status: "in_progress",
      workStatus: "running",
      currentIntent: "mention",
      lastHumanCommentId: "comment-1",
    });
    expect(dispatchIssueSession).toHaveBeenCalledTimes(1);
  });

  it("stores follow-ups while running without dispatching another session", async () => {
    const store = new IssueWorkStore(DB_PATH);
    const dispatchIssueSession = vi.fn(async () => undefined);
    const dispatcher = new IssueWorkDispatcher({
      store,
      logger: { info: vi.fn(), error: vi.fn() },
      dispatchIssueSession,
    });

    await dispatcher.dispatchActions([action()]);
    const followUp = await dispatcher.dispatchActions([commentAction("comment-1")]);

    expect(followUp).toMatchObject({
      type: "not_dispatchable",
      issueId: "EUG-55",
      reason: "deduped_or_stored_pending_followup",
    });
    expect(store.getWork("EUG-55")).toMatchObject({
      status: "in_progress",
      workStatus: "running",
      pendingFollowUpCommentIds: ["comment-1"],
      pendingFollowUpCount: 1,
    });
    expect(dispatchIssueSession).toHaveBeenCalledTimes(1);
  });

  it("claims promoted pending follow-up work before dispatching it", async () => {
    const store = new IssueWorkStore(DB_PATH);
    const dispatchIssueSession = vi.fn(async () => undefined);
    const dispatcher = new IssueWorkDispatcher({
      store,
      logger: { info: vi.fn(), error: vi.fn() },
      dispatchIssueSession,
    });

    await dispatcher.dispatchActions([action()]);
    await dispatcher.dispatchActions([commentAction("comment-1")]);
    await store.complete("EUG-55");

    const decision = await dispatcher.dispatchPendingIssueWork("EUG-55");

    expect(decision).toMatchObject({
      type: "dispatched",
      issueId: "EUG-55",
      item: { issueId: "EUG-55", status: "in_progress" },
    });
    expect(store.getWork("EUG-55")).toMatchObject({
      status: "in_progress",
      workStatus: "running",
      event: "mention",
    });
    expect(dispatchIssueSession).toHaveBeenCalledTimes(2);
  });

  it("dispatches pending backlog after startup recovery makes stale work claimable", async () => {
    const store = new IssueWorkStore(DB_PATH);
    const dispatchIssueSession = vi.fn(async () => undefined);
    const dispatcher = new IssueWorkDispatcher({
      store,
      logger: { info: vi.fn(), error: vi.fn() },
      dispatchIssueSession,
    });

    await dispatcher.dispatchActions([action()]);
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

    const result = await dispatcher.dispatchPendingBacklog();

    expect(result).toMatchObject({
      attempted: 1,
      dispatched: 1,
      decisions: [
        {
          type: "dispatched",
          issueId: "EUG-55",
        },
      ],
    });
    expect(store.getWork("EUG-55")).toMatchObject({
      status: "in_progress",
      workStatus: "running",
      leaseOwner: "issue-session:EUG-55",
    });
    expect(dispatchIssueSession).toHaveBeenCalledTimes(2);
    expect(dispatchIssueSession).toHaveBeenLastCalledWith({
      issueId: "EUG-55",
      fallbackAgentId: "main",
      actions: undefined,
    });
  });

  it("keeps recovered backlog pending when startup dispatch fails", async () => {
    const store = new IssueWorkStore(DB_PATH);
    await store.enqueue([action()].map((a) => ({
      id: a.commentId || a.identifier,
      issueId: a.identifier,
      linearIssueUuid: a.issueId,
      event: a.event,
      summary: a.issueLabel,
      issuePriority: a.issuePriority,
      commentBody: a.commentBody,
      createdAt: a.createdAt,
    })));
    const dispatchIssueSession = vi.fn(async () => {
      throw new Error("runtime unavailable");
    });
    const dispatcher = new IssueWorkDispatcher({
      store,
      logger: { info: vi.fn(), error: vi.fn() },
      dispatchIssueSession,
    });

    const result = await dispatcher.dispatchPendingBacklog();

    expect(result).toMatchObject({
      attempted: 1,
      dispatched: 1,
      decisions: [
        {
          type: "dispatched",
          issueId: "EUG-55",
        },
      ],
    });
    await vi.waitFor(() => {
      expect(store.getWork("EUG-55")).toMatchObject({
        status: "pending",
        workStatus: "pending",
        leaseOwner: null,
        leaseExpiresAt: null,
      });
    });
    expect(await store.peek()).toHaveLength(1);
  });

  it("only one concurrent backlog dispatch can claim pending issue work", async () => {
    const store = new IssueWorkStore(DB_PATH);
    await store.enqueue([action()].map((a) => ({
      id: a.commentId || a.identifier,
      issueId: a.identifier,
      linearIssueUuid: a.issueId,
      event: a.event,
      summary: a.issueLabel,
      issuePriority: a.issuePriority,
      commentBody: a.commentBody,
      createdAt: a.createdAt,
    })));
    let releaseDispatch!: () => void;
    let firstDispatch!: Promise<unknown>;
    const dispatchStarted = new Promise<void>((resolve) => {
      const dispatchIssueSession = vi.fn(() => new Promise<void>((resolveDispatch) => {
        releaseDispatch = resolveDispatch;
        resolve();
      }));
      const dispatcherOne = new IssueWorkDispatcher({
        store,
        logger: { info: vi.fn(), error: vi.fn() },
        dispatchIssueSession,
      });
      firstDispatch = dispatcherOne.dispatchPendingBacklog();
    });
    await dispatchStarted;

    const dispatchIssueSessionTwo = vi.fn(async () => undefined);
    const dispatcherTwo = new IssueWorkDispatcher({
      store,
      logger: { info: vi.fn(), error: vi.fn() },
      dispatchIssueSession: dispatchIssueSessionTwo,
    });
    const result = await dispatcherTwo.dispatchPendingBacklog();
    releaseDispatch();
    await firstDispatch;

    expect(result).toMatchObject({
      attempted: 0,
      dispatched: 0,
    });
    expect(dispatchIssueSessionTwo).not.toHaveBeenCalled();
    expect(store.getWork("EUG-55")).toMatchObject({
      status: "in_progress",
      workStatus: "running",
    });
  });

  it("defers completion while the active Codex run is still running", async () => {
    const store = new IssueWorkStore(DB_PATH);
    const dispatchIssueSession = vi.fn(async () => undefined);
    const moveIssueToReview = vi.fn(async () => undefined);
    const dispatcher = new IssueWorkDispatcher({
      store,
      logger: { info: vi.fn(), error: vi.fn() },
      moveIssueToReview,
      dispatchIssueSession,
    });

    await dispatcher.dispatchActions([action()]);
    store.setActiveCodexRun("EUG-55", "run-1");

    const decision = await dispatcher.completeIssueWork("EUG-55");

    expect(decision).toMatchObject({
      type: "not_completed",
      issueId: "EUG-55",
      reason: "codex_still_running",
    });
    expect(store.getWork("EUG-55")).toMatchObject({
      status: "in_progress",
      workStatus: "running",
      activeCodexRunId: "run-1",
    });
    expect(moveIssueToReview).not.toHaveBeenCalled();
    expect(dispatchIssueSession).toHaveBeenCalledTimes(1);
  });

  it("moves completed issue work to review after the active Codex run exits", async () => {
    const store = new IssueWorkStore(DB_PATH);
    const dispatchIssueSession = vi.fn(async () => undefined);
    const moveIssueToReview = vi.fn(async () => undefined);
    const dispatcher = new IssueWorkDispatcher({
      store,
      logger: { info: vi.fn(), error: vi.fn() },
      moveIssueToReview,
      dispatchIssueSession,
    });

    await dispatcher.dispatchActions([action()]);
    store.setActiveCodexRun("EUG-55", "run-1");
    vi.spyOn(store, "getCodexRun").mockReturnValue({
      runId: "run-1",
      issueId: "EUG-55",
      codexThreadId: "thread-1",
      wrapperPid: null,
      codexPid: null,
      workdir: "/tmp/work",
      status: "exited",
      startedAt: "2026-04-19T00:00:00.000Z",
      finishedAt: "2026-04-19T00:01:00.000Z",
      exitCode: 0,
      lastVisibleAssistantTextAt: "2026-04-19T00:00:30.000Z",
      promptPreview: "Do work",
    } satisfies CodexRunRecord);

    const decision = await dispatcher.completeIssueWork("EUG-55");

    expect(decision).toMatchObject({
      type: "completed",
      issueId: "EUG-55",
      transition: "in_review",
    });
    expect(store.getWork("EUG-55")).toMatchObject({
      status: "pending",
      workStatus: "in_review",
      activeCodexRunId: null,
    });
    expect(moveIssueToReview).toHaveBeenCalledWith("EUG-55");
    expect(dispatchIssueSession).toHaveBeenCalledTimes(1);
  });

  it("promotes and dispatches pending follow-up work after completion", async () => {
    const store = new IssueWorkStore(DB_PATH);
    const dispatchIssueSession = vi.fn(async () => undefined);
    const moveIssueToReview = vi.fn(async () => undefined);
    const dispatcher = new IssueWorkDispatcher({
      store,
      logger: { info: vi.fn(), error: vi.fn() },
      moveIssueToReview,
      dispatchIssueSession,
    });

    await dispatcher.dispatchActions([action()]);
    store.setActiveCodexRun("EUG-55", "run-1");
    await dispatcher.dispatchActions([commentAction("comment-1")]);
    vi.spyOn(store, "getCodexRun").mockReturnValue({
      runId: "run-1",
      issueId: "EUG-55",
      codexThreadId: "thread-1",
      wrapperPid: null,
      codexPid: null,
      workdir: "/tmp/work",
      status: "exited",
      startedAt: "2026-04-19T00:00:00.000Z",
      finishedAt: "2026-04-19T00:01:00.000Z",
      exitCode: 0,
      lastVisibleAssistantTextAt: "2026-04-19T00:00:30.000Z",
      promptPreview: "Do work",
    } satisfies CodexRunRecord);

    const decision = await dispatcher.completeIssueWork("EUG-55");

    expect(decision).toMatchObject({
      type: "dispatched_followup",
      issueId: "EUG-55",
      dispatch: {
        type: "dispatched",
        item: { issueId: "EUG-55", event: "mention", status: "in_progress" },
      },
    });
    expect(store.getWork("EUG-55")).toMatchObject({
      status: "in_progress",
      workStatus: "running",
      event: "mention",
      activeCodexRunId: null,
      pendingFollowUpCommentIds: [],
    });
    expect(moveIssueToReview).not.toHaveBeenCalled();
    expect(dispatchIssueSession).toHaveBeenCalledTimes(2);
  });
});
