import { Type, type Static } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk";
import { jsonResult, stringEnum } from "openclaw/plugin-sdk/agent-runtime";
import { readDebugLogEntries } from "../debug-log.js";
import type { IssueWorkStore } from "../issue-work-store.js";

export type IssueWorkToolOptions = {
  completeIssueWork?: (issueId: string) => Promise<{ type: string } & Record<string, unknown>>;
  debugLogRoot?: string;
};

const IssueWorkAction = stringEnum(
  ["view", "complete", "recover", "debug"] as const,
  {
    description:
      "view: inspect one issue work record. " +
      "complete: ask the dispatcher to reconcile finished issue work. " +
      "recover: recover expired issue work leases. " +
      "debug: read recent issue/session/event debug JSONL entries.",
  },
);

const DebugScope = stringEnum(["issue", "session", "event"] as const);

const IssueWorkToolParams = Type.Object({
  action: IssueWorkAction,
  issueId: Type.Optional(Type.String({ description: "Linear issue identifier, e.g. EUG-55." })),
  sessionKey: Type.Optional(Type.String({ description: "OpenClaw session key for debug log lookup." })),
  deliveryId: Type.Optional(Type.String({ description: "Linear webhook delivery ID for debug log lookup." })),
  scope: Type.Optional(DebugScope),
  limit: Type.Optional(Type.Number({ description: "Maximum debug log or run records to return." })),
  includeUnleased: Type.Optional(Type.Boolean({ description: "Recover in-progress rows that do not have a lease timestamp." })),
});

type IssueWorkToolParams = Static<typeof IssueWorkToolParams>;

export function createIssueWorkTool(store: IssueWorkStore, options: IssueWorkToolOptions = {}): AnyAgentTool {
  return {
    name: "linear_issue_work",
    label: "Linear Issue Work",
    description:
      "Inspect and complete deterministic issue-scoped Linear work. " +
      "Normal sessions should use this tool for issue work lifecycle operations instead of the compatibility linear_queue tool.",
    parameters: IssueWorkToolParams,
    async execute(_toolCallId: string, params: IssueWorkToolParams) {
      switch (params.action) {
        case "view": {
          if (!params.issueId) return jsonResult({ error: "issueId is required for 'view' action" });
          const limit = params.limit ?? 10;
          return jsonResult({
            issueId: params.issueId,
            work: store.getWork(params.issueId),
            codexRuns: store.listCodexRuns(params.issueId, limit),
          });
        }
        case "complete": {
          if (!params.issueId) return jsonResult({ error: "issueId is required for 'complete' action" });
          if (options.completeIssueWork) {
            const decision = await options.completeIssueWork(params.issueId);
            return jsonResult({
              completed: decision.type !== "not_completed",
              issueId: params.issueId,
              decision,
            });
          }
          const result = store.completeIssueWork(params.issueId);
          return jsonResult({
            completed: result.completed,
            issueId: params.issueId,
            result,
          });
        }
        case "recover": {
          const recovered = store.recoverExpiredLeases(new Date(), { includeUnleased: Boolean(params.includeUnleased) });
          return jsonResult({
            recovered,
            message: recovered > 0
              ? "Recovered stale issue work records"
              : "No expired issue work leases found",
          });
        }
        case "debug": {
          if (!options.debugLogRoot) return jsonResult({ error: "debugLogRoot is not configured" });
          const limit = params.limit ?? 50;
          const scope = params.scope
            ?? (params.deliveryId ? "event" : params.sessionKey ? "session" : "issue");
          const id = scope === "event"
            ? params.deliveryId
            : scope === "session"
              ? params.sessionKey
              : params.issueId;
          if (!id) {
            return jsonResult({
              error: "debug requires issueId, sessionKey, or deliveryId",
            });
          }
          return jsonResult({
            scope,
            id,
            entries: readDebugLogEntries(options.debugLogRoot, scope, id, limit),
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
