import { describe, expect, it } from "vitest";
import {
  buildLinearIssueWorkPacket,
  formatLinearIssueWorkPacketMessage,
} from "../src/work-packet.js";
import type { RouterAction } from "../src/event-router.js";
import type { IssueContext } from "../src/linear-api.js";
import type { IssueWorkRecord } from "../src/issue-work-store.js";

function work(overrides: Partial<IssueWorkRecord> = {}): IssueWorkRecord {
  return {
    id: "EUG-55",
    issueId: "EUG-55",
    event: "ticket",
    summary: "EUG-55: Test issue",
    priority: 1,
    addedAt: "2026-04-19T00:00:00Z",
    updatedAt: "2026-04-19T00:00:00Z",
    status: "pending",
    workStatus: "pending",
    currentIntent: "ticket",
    activeEventKeys: ["EUG-55:ticket"],
    pendingEventKeys: [],
    pendingFollowUpCommentIds: [],
    pendingFollowUpCount: 0,
    sessionKey: "agent:main:linear:direct:issue:eug-55",
    codexThreadId: null,
    activeCodexRunId: null,
    workspace: "/tmp/worktrees/EUG-55",
    lastProcessedCommentId: null,
    lastHumanCommentId: null,
    lastOpenClawCommentId: null,
    ...overrides,
  };
}

function issue(): IssueContext {
  return {
    identifier: "EUG-55",
    title: "Test issue",
    description: "#noto\nFix the editor.",
    state: "Todo",
    priority: "High",
    assignee: "OpenClaw",
    comments: [],
  };
}

function commentAction(): RouterAction {
  return {
    type: "wake",
    agentId: "main",
    event: "comment.mention",
    detail: "New comment on issue EUG-55\n\n> Please retry.",
    issueId: "linear-uuid",
    issueLabel: "EUG-55: Test issue",
    identifier: "EUG-55",
    issuePriority: 1,
    linearUserId: "openclaw-user",
    commentId: "comment-1",
    commentBody: "Please retry.",
    createdAt: "2026-04-19T00:01:00Z",
  };
}

describe("linear issue work packet", () => {
  it("builds a new issue packet with issue snapshot and workspace", () => {
    const packet = buildLinearIssueWorkPacket({
      work: work(),
      issue: issue(),
      actions: [],
    });

    expect(packet).toMatchObject({
      kind: "linear_issue_work",
      version: 1,
      issueId: "EUG-55",
      intent: "new_issue_assignment",
      runMode: "start",
      workspace: "/tmp/worktrees/EUG-55",
      issue: { title: "Test issue" },
      work: {
        queueStatus: "pending",
        currentIntent: "ticket",
        activeEventIds: ["EUG-55"],
      },
    });
  });

  it("builds a follow-up packet with the new comment and resume mode", () => {
    const packet = buildLinearIssueWorkPacket({
      work: work({
        event: "mention",
        currentIntent: "mention",
        codexThreadId: "thread-1",
        activeEventKeys: ["comment-1:mention"],
        lastHumanCommentId: "comment-1",
      }),
      issue: issue(),
      actions: [commentAction()],
    });

    expect(packet).toMatchObject({
      intent: "human_followup",
      runMode: "resume",
      newComments: [
        {
          id: "comment-1",
          body: "Please retry.",
          createdAt: "2026-04-19T00:01:00Z",
        },
      ],
      work: {
        codexThreadId: "thread-1",
        lastHumanCommentId: "comment-1",
      },
    });
  });

  it("formats packet as a session-readable JSON message", () => {
    const message = formatLinearIssueWorkPacketMessage(
      buildLinearIssueWorkPacket({ work: work(), issue: issue() }),
    );

    expect(message).toContain("Linear issue work packet for EUG-55.");
    expect(message).toContain("The dispatcher already claimed this issue work.");
    expect(message).toContain("```json");
    expect(message).toContain('"kind": "linear_issue_work"');
  });
});
