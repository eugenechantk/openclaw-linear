import { Type, type Static } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk";
import { jsonResult, stringEnum } from "openclaw/plugin-sdk/agent-runtime";
import type { EnqueueEntry, QueueItem } from "../work-queue.js";

export type LinearQueue = {
  enqueue(entries: EnqueueEntry[]): Promise<number>;
  peek(): Promise<QueueItem[]>;
  pop(): Promise<QueueItem | null>;
  claim(issueId: string): Promise<QueueItem | null>;
  drain(): Promise<QueueItem[]>;
  complete(issueId: string): Promise<boolean>;
  recover(): Promise<number>;
};

export type QueueToolOptions = {
  onIssueComplete?: (issueId: string) => Promise<void>;
  completeIssueWork?: (issueId: string) => Promise<{ type: string } & Record<string, unknown>>;
};

const QueueAction = stringEnum(
  ["peek", "claim", "pop", "drain", "complete"] as const,
  {
    description:
      "peek: view all pending items without removing them. " +
      "claim: claim the highest-priority pending item for a specific issueId. " +
      "pop: claim the highest-priority pending item. " +
      "drain: claim all pending items. " +
      "complete: finish work on an in-progress item (requires issueId).",
  },
);

const QueueToolParams = Type.Object({
  action: QueueAction,
  issueId: Type.Optional(
    Type.String({ description: "Issue ID to claim or complete (required for 'claim' and 'complete' actions)." }),
  ),
});

type QueueToolParams = Static<typeof QueueToolParams>;

export function createQueueTool(queue: LinearQueue, options: QueueToolOptions = {}): AnyAgentTool {
  return {
    name: "linear_queue",
    label: "Linear Queue",
    description:
      "Manage the Linear notification inbox queue. " +
      "Use 'peek' to see pending items, 'claim' to claim the next item for one issue, " +
      "'pop' to claim the next global item, 'drain' to claim all items, " +
      "or 'complete' to finish work on a claimed item.",
    parameters: QueueToolParams,
    async execute(_toolCallId: string, params: QueueToolParams) {
      switch (params.action) {
        case "peek": {
          const items = await queue.peek();
          return jsonResult({ count: items.length, items });
        }
        case "pop": {
          const item = await queue.pop();
          return jsonResult(item ? { item } : { item: null, message: "Queue is empty" });
        }
        case "claim": {
          if (!params.issueId) {
            return jsonResult({ error: "issueId is required for 'claim' action" });
          }
          const item = await queue.claim(params.issueId);
          return jsonResult(
            item
              ? { item, issueId: params.issueId }
              : { item: null, issueId: params.issueId, message: "No pending item for issue" },
          );
        }
        case "drain": {
          const items = await queue.drain();
          return jsonResult({ count: items.length, items });
        }
        case "complete": {
          if (!params.issueId) {
            return jsonResult({ error: "issueId is required for 'complete' action" });
          }
          if (options.completeIssueWork) {
            const decision = await options.completeIssueWork(params.issueId);
            const remaining = await queue.peek();
            return jsonResult({
              completed: decision.type !== "not_completed",
              issueId: params.issueId,
              remaining: remaining.length,
              decision,
            });
          }
          const completed = await queue.complete(params.issueId);
          const remaining = await queue.peek();
          const issueStillPending = remaining.some((item) => item.issueId === params.issueId);
          if (completed && !issueStillPending) {
            await options.onIssueComplete?.(params.issueId);
          }
          return jsonResult({
            completed,
            issueId: params.issueId,
            remaining: remaining.length,
          });
        }
        default:
          return jsonResult({
            error: `Unknown action: ${(params as { action: string }).action}`,
          });
      }
    },
  };
}
