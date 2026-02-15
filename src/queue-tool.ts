import { Type, type Static } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import type { InboxQueue } from "./work-queue.js";

const QueueAction = Type.Unsafe<"peek" | "pop" | "drain">({
  type: "string",
  enum: ["peek", "pop", "drain"],
  description:
    "peek: view all pending items without removing them. " +
    "pop: remove and return the highest-priority item. " +
    "drain: remove and return all items.",
});

const QueueToolParams = Type.Object({
  action: QueueAction,
});

type QueueToolParams = Static<typeof QueueToolParams>;

export function createQueueTool(queue: InboxQueue): AnyAgentTool {
  return {
    name: "linear_queue",
    label: "Linear Queue",
    description:
      "Manage the Linear notification inbox queue. " +
      "Use 'peek' to see pending items, 'pop' to take the next item, or 'drain' to take all items.",
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
        case "drain": {
          const items = await queue.drain();
          return jsonResult({ count: items.length, items });
        }
        default:
          return jsonResult({
            error: `Unknown action: ${(params as { action: string }).action}`,
          });
      }
    },
  };
}
