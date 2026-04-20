import type { RouterAction } from "./event-router.js";
import type { IssueContext } from "./linear-api.js";
import type { IssueWorkRecord } from "./issue-work-store.js";

export type LinearIssueWorkPacket = {
  kind: "linear_issue_work";
  version: 1;
  issueId: string;
  intent: "new_issue_assignment" | "human_followup" | "issue_update" | "pending_issue_work";
  runMode: "start" | "resume";
  workspace: string | null;
  issue: IssueContext | null;
  newComments: { id: string; body?: string; createdAt?: string }[];
  work: {
    status: string | null;
    queueStatus: string;
    currentIntent: string | null;
    activeEventIds: string[];
    pendingEventIds: string[];
    pendingFollowUpCommentIds: string[];
    pendingFollowUpCount: number;
    codexThreadId: string | null;
    activeCodexRunId: string | null;
    sessionKey: string | null;
    lastProcessedCommentId: string | null;
    lastHumanCommentId: string | null;
    lastOpenClawCommentId: string | null;
  };
  instructions: string;
};

type BuildPacketParams = {
  work: IssueWorkRecord;
  issue: IssueContext | null;
  actions?: RouterAction[];
};

export function buildLinearIssueWorkPacket(params: BuildPacketParams): LinearIssueWorkPacket {
  const actions = params.actions ?? [];
  const intent = resolveIntent(params.work, actions);
  const newComments = actions
    .filter((action) => action.event === "comment.mention" && action.commentId)
    .map((action) => ({
      id: action.commentId as string,
      body: action.commentBody,
      createdAt: action.createdAt,
    }));

  return {
    kind: "linear_issue_work",
    version: 1,
    issueId: params.work.issueId,
    intent,
    runMode: params.work.codexThreadId ? "resume" : "start",
    workspace: params.work.workspace ?? null,
    issue: params.issue,
    newComments,
    work: {
      status: params.work.workStatus ?? null,
      queueStatus: params.work.status,
      currentIntent: params.work.currentIntent ?? null,
      activeEventIds: params.work.activeEventKeys.map(eventIdFromKey),
      pendingEventIds: params.work.pendingEventKeys.map(eventIdFromKey),
      pendingFollowUpCommentIds: params.work.pendingFollowUpCommentIds ?? [],
      pendingFollowUpCount: params.work.pendingFollowUpCount ?? 0,
      codexThreadId: params.work.codexThreadId ?? null,
      activeCodexRunId: params.work.activeCodexRunId ?? null,
      sessionKey: params.work.sessionKey ?? null,
      lastProcessedCommentId: params.work.lastProcessedCommentId ?? null,
      lastHumanCommentId: params.work.lastHumanCommentId ?? null,
      lastOpenClawCommentId: params.work.lastOpenClawCommentId ?? null,
    },
    instructions: instructionForIntent(intent),
  };
}

export function formatLinearIssueWorkPacketMessage(packet: LinearIssueWorkPacket): string {
  return [
    `Linear issue work packet for ${packet.issueId}.`,
    "",
    "Use this structured packet as the source of truth for routing and work context.",
    "The dispatcher already claimed this issue work. Process the packet intent; do not claim global queue items first.",
    "",
    "```json",
    JSON.stringify(packet, null, 2),
    "```",
  ].join("\n");
}

function resolveIntent(
  work: IssueWorkRecord,
  actions: RouterAction[],
): LinearIssueWorkPacket["intent"] {
  if (actions.some((action) => action.event === "comment.mention")) return "human_followup";
  if (actions.some((action) => action.event === "issue.assigned" || action.event === "issue.state_readded")) {
    return "new_issue_assignment";
  }
  if (work.event === "mention") return "human_followup";
  if (work.event === "ticket") return "new_issue_assignment";
  return "pending_issue_work";
}

function instructionForIntent(intent: LinearIssueWorkPacket["intent"]): string {
  switch (intent) {
    case "new_issue_assignment":
      return "Implement the assigned Linear issue. Use the issue snapshot and comments for context.";
    case "human_followup":
      return "Process Eugene's new follow-up comment in the existing issue context.";
    case "issue_update":
      return "Process the actionable Linear issue update.";
    case "pending_issue_work":
      return "Process the pending issue work record.";
  }
}

function eventIdFromKey(key: string): string {
  const idx = key.lastIndexOf(":");
  return idx === -1 ? key : key.slice(0, idx);
}
