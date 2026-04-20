import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createWebhookHandler } from "./webhook-handler.js";
import { createEventRouter, type RouterAction } from "./event-router.js";
import { IssueWorkStore } from "./issue-work-store.js";
import { IssueWorkDispatcher } from "./issue-work-dispatcher.js";
import { LinearDebugLogger, resolveLinearDebugRoot } from "./debug-log.js";
import { createQueueTool } from "./tools/queue-tool.js";
import { createIssueWorkTool } from "./tools/issue-work-tool.js";
import { DEFAULT_OPENCLAW_ACTOR_ID, normalizeLinearEvent } from "./event-normalizer.js";
import { WebhookEventStore } from "./webhook-event-store.js";
import { buildLinearIssueWorkPacket, formatLinearIssueWorkPacketMessage } from "./work-packet.js";
import {
  createIssueComment,
  fetchIssueWorkflowState,
  issueHasRecentCommentBody,
  setApiKey,
  fetchIssueContext,
  assignIssueToViewer,
  updateIssueStateByName,
} from "./linear-api.js";
import { LinearAssistantOutputMirror, type AssistantMirrorAgentEvent } from "./assistant-output-mirror.js";
import { createIssueTool } from "./tools/linear-issue-tool.js";
import { createCommentTool } from "./tools/linear-comment-tool.js";
import { createTeamTool } from "./tools/linear-team-tool.js";
import { createProjectTool } from "./tools/linear-project-tool.js";
import { createRelationTool } from "./tools/linear-relation-tool.js";

const CHANNEL_ID = "linear";
const DEFAULT_DEBOUNCE_MS = 30_000;
const DEFAULT_REOPEN_STATE = "In Progress";
const DEFAULT_COMPLETE_STATE = "In Review";

interface LinearReplyPayload {
  text?: string;
  isReasoning?: boolean;
  isCompactionNotice?: boolean;
}

function resolveSqlitePath(api: OpenClawPluginApi): string {
  const configuredPath = api.pluginConfig?.["sqlitePath"];
  if (typeof configuredPath === "string" && configuredPath.trim()) {
    return isAbsolute(configuredPath)
      ? configuredPath
      : join(process.env.OPENCLAW_HOME ?? join(homedir(), ".openclaw"), configuredPath);
  }

  return join(process.env.OPENCLAW_HOME ?? join(homedir(), ".openclaw"), "queue", "linear.sqlite");
}

const EVENT_LABELS: Record<string, string> = {
  "issue.assigned": "Assigned",
  "issue.unassigned": "Unassigned",
  "issue.reassigned": "Reassigned",
  "issue.removed": "Removed",
  "issue.state_removed": "State Removed",
  "issue.state_readded": "State Re-added",
  "issue.priority_changed": "Priority Changed",
  "comment.mention": "Mentioned",
};

export function formatConsolidatedMessage(actions: RouterAction[]): string {
  if (actions.length === 1) {
    return actions[0].detail;
  }

  const lines = actions.map((a, i) => {
    const label = EVENT_LABELS[a.event] ?? a.event;
    const summary = formatActionSummary(a);
    return `${i + 1}. [${label}] ${summary}`;
  });

  return `You have ${actions.length} new Linear notifications:\n\n${lines.join("\n")}\n\nReview and prioritize before starting work.`;
}

function formatActionSummary(action: RouterAction): string {
  if (action.event === "comment.mention") {
    const bodyStart = action.detail.indexOf("\n\n> ");
    if (bodyStart !== -1) {
      const quote = action.detail.slice(bodyStart + 4); // skip "\n\n> "
      return `${action.issueLabel}: "${quote}"`;
    }
  }

  return action.issueLabel || action.detail;
}

async function dispatchConsolidatedActions(
  actions: RouterAction[],
  dispatcher: IssueWorkDispatcher,
): Promise<void> {
  if (actions.length === 0) return;

  await dispatcher.dispatchActions(actions);
}

async function dispatchIssueWorkSession(params: {
  issueId: string;
  fallbackAgentId: string;
  actions?: RouterAction[];
  api: OpenClawPluginApi;
  store: IssueWorkStore;
  assistantOutputMirror: LinearAssistantOutputMirror;
}): Promise<void> {
  const core = params.api.runtime;
  const cfg = params.api.config;
  const issuePeerId = `issue:${params.issueId}`;

  const route = core.channel.routing.resolveAgentRoute({
    cfg,
    channel: CHANNEL_ID,
    accountId: "default",
    peer: {
      kind: "direct" as const,
      id: issuePeerId,
    },
  });

  params.store.setSessionKey(params.issueId, route.sessionKey);
  const issueCtx = await fetchIssueContext(params.issueId);
  const work = params.store.getWork(params.issueId);
  if (!work) {
    params.api.logger.info(`[linear] No issue work record for ${params.issueId}; skipping session dispatch`);
    return;
  }

  const packet = buildLinearIssueWorkPacket({
    work,
    issue: issueCtx,
    actions: params.actions,
  });
  const body = formatLinearIssueWorkPacketMessage(packet);

  const ctx = core.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: body,
    RawBody: body,
    CommandBody: body,
    From: `${CHANNEL_ID}:${issuePeerId}`,
    To: `${CHANNEL_ID}:${route.agentId ?? params.fallbackAgentId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId ?? "default",
    ChatType: "direct",
    ConversationLabel: `Linear: ${params.issueId}`,
    SenderId: issuePeerId,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `${CHANNEL_ID}:${issuePeerId}`,
  });

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx,
    cfg,
    dispatcherOptions: {
      deliver: async (payload: LinearReplyPayload, info: { kind: string }) => {
        if (info.kind === "tool") return;
        if (payload.isReasoning || payload.isCompactionNotice) return;
        if (typeof payload.text !== "string" || !payload.text.trim()) return;
        await params.assistantOutputMirror.mirrorText(params.issueId, payload.text);
      },
      onError: (err: unknown) => {
        params.api.logger.error(
          `[linear] Reply error: ${formatErrorMessage(err)}`,
        );
      },
    },
  });
}

async function reopenCompletedHumanFollowup(
  normalized: ReturnType<typeof normalizeLinearEvent>,
  reopenState: string,
  api: OpenClawPluginApi,
): Promise<void> {
  if (normalized.action !== "process" || normalized.intent !== "human_followup") return;

  const issueRef = normalized.issueId ?? normalized.identifier;
  if (!issueRef) return;

  const current = await fetchIssueWorkflowState(issueRef);
  if (current?.stateType !== "completed") return;

  const updated = await updateIssueStateByName(current.id, reopenState);
  api.logger.info(
    `[linear] Reopened ${current.identifier} from ${current.stateName ?? "completed"} to ${updated?.stateName ?? reopenState} after human follow-up`,
  );
}

let activeDebouncer: { flushKey: (key: string) => Promise<void> } | undefined;
const activeDebouncerKeys = new Set<string>();
let activeAssistantMirrorUnsubscribe: (() => void) | undefined;
let activeLeaseRecoveryInterval: ReturnType<typeof setInterval> | undefined;

export function activate(api: OpenClawPluginApi): void {
  api.logger.info("Linear plugin activated");

  const linearApiKey = api.pluginConfig?.["apiKey"];
  if (typeof linearApiKey !== "string" || !linearApiKey) {
    api.logger.error("[linear] apiKey is not configured — plugin is inert");
    return;
  }
  setApiKey(linearApiKey);

  const webhookSecret = api.pluginConfig?.["webhookSecret"];
  if (typeof webhookSecret !== "string" || !webhookSecret) {
    api.logger.error("[linear] webhookSecret is not configured — plugin is inert");
    return;
  }

  const agentMapping =
    (api.pluginConfig?.["agentMapping"] as Record<string, string>) ?? {};
  if (Object.keys(agentMapping).length === 0) {
    api.logger.info("[linear] agentMapping is empty — all events will be dropped");
  }
  const defaultAgentId =
    typeof api.pluginConfig?.["defaultAgentId"] === "string" && api.pluginConfig["defaultAgentId"].trim()
      ? api.pluginConfig["defaultAgentId"].trim()
      : "main";

  const eventFilter =
    (api.pluginConfig?.["eventFilter"] as string[]) ?? [];
  const teamIds =
    (api.pluginConfig?.["teamIds"] as string[]) ?? [];
  const rawDebounceMs = api.pluginConfig?.["debounceMs"] as number | undefined;
  const debounceMs =
    (typeof rawDebounceMs === "number" && rawDebounceMs > 0)
      ? rawDebounceMs
      : DEFAULT_DEBOUNCE_MS;
  const reopenState =
    typeof api.pluginConfig?.["reopenState"] === "string" && api.pluginConfig["reopenState"].trim()
      ? api.pluginConfig["reopenState"].trim()
      : DEFAULT_REOPEN_STATE;
  const completeState =
    typeof api.pluginConfig?.["completeState"] === "string" && api.pluginConfig["completeState"].trim()
      ? api.pluginConfig["completeState"].trim()
      : DEFAULT_COMPLETE_STATE;
  const openclawActorId =
    typeof api.pluginConfig?.["openclawActorId"] === "string" && api.pluginConfig["openclawActorId"]
      ? api.pluginConfig["openclawActorId"] as string
      : DEFAULT_OPENCLAW_ACTOR_ID;
  const ignoredActorIds =
    Array.isArray(api.pluginConfig?.["ignoredActorIds"])
      ? (api.pluginConfig?.["ignoredActorIds"] as unknown[]).filter((id): id is string => typeof id === "string")
      : [];
  const ignoredNormalizerActorIds = [...new Set([
    ...ignoredActorIds,
    ...Object.keys(agentMapping),
  ])];

  const sqlitePath = resolveSqlitePath(api);
  api.logger.info(`[linear] SQLite state path: ${sqlitePath}`);
  const debugRoot = resolveLinearDebugRoot(api.pluginConfig?.["debugLogPath"]);
  api.logger.info(`[linear] Debug log path: ${debugRoot}`);
  const debugLog = new LinearDebugLogger(debugRoot, api.logger);
  const issueWorkStore = new IssueWorkStore(sqlitePath);
  const webhookEventStore = new WebhookEventStore(sqlitePath);

  const recoverExpiredLeases = (includeUnleased = false): number => {
    const count = issueWorkStore.recoverExpiredLeases(new Date(), {
      includeUnleased,
      unleasedOlderThanMs: includeUnleased ? 300_000 : undefined,
    });
    if (count > 0) {
      api.logger.info(`[linear] Recovered ${count} stale issue work lease(s)`);
      debugLog.append({
        type: "lease.recovered",
        count,
        includeUnleased,
      });
    }
    return count;
  };

  try {
    recoverExpiredLeases(true);
  } catch (err) {
    api.logger.error(`[linear] Issue work recovery failed: ${formatErrorMessage(err)}`);
  }

  const assistantOutputMirror = new LinearAssistantOutputMirror({
    logger: api.logger,
    postComment: async (issueIdentifier, body) => {
      if (await issueHasRecentCommentBody(issueIdentifier, body)) {
        api.logger.info(`[linear] Skipped duplicate assistant output for ${issueIdentifier}`);
        return false;
      }
      return Boolean(await createIssueComment(issueIdentifier, body));
    },
  });
  activeAssistantMirrorUnsubscribe?.();
  activeAssistantMirrorUnsubscribe = api.runtime.events.onAgentEvent((event) => {
    assistantOutputMirror.handleAgentEvent(event as AssistantMirrorAgentEvent).catch((err) => {
      api.logger.error(
        `[linear] Assistant output mirror failed: ${formatErrorMessage(err)}`,
      );
    });
  });

  const issueWorkDispatcher = new IssueWorkDispatcher({
    store: issueWorkStore,
    logger: api.logger,
    debugLog,
    assignIssueOwner: async (issueId) => {
      const updated = await assignIssueToViewer(issueId);
      api.logger.info(
        `[linear] Assigned ${updated?.identifier ?? issueId} to ${updated?.assignee?.name ?? "OpenClaw"} before dispatch`,
      );
    },
    moveIssueToReview: async (issueId) => {
      try {
        const updated = await updateIssueStateByName(issueId, completeState);
        api.logger.info(
          `[linear] Moved ${issueId} to ${updated?.stateName ?? completeState} after dispatcher completion`,
        );
      } catch (err) {
        api.logger.error(
          `[linear] Complete state update failed for ${issueId}: ${formatErrorMessage(err)}`,
        );
      }
    },
    dispatchIssueSession: async ({ issueId, fallbackAgentId, actions }) => {
      await dispatchIssueWorkSession({
        issueId,
        fallbackAgentId,
        actions,
        api,
        store: issueWorkStore,
        assistantOutputMirror,
      });
    },
  });

  let dispatchBacklogInProgress = false;
  const dispatchPendingBacklog = async (reason: string): Promise<void> => {
    if (dispatchBacklogInProgress) {
      api.logger.info(`[linear] Skipping pending issue work dispatch for ${reason}; dispatch already running`);
      return;
    }

    dispatchBacklogInProgress = true;
    try {
      const result = await issueWorkDispatcher.dispatchPendingBacklog();
      if (result.attempted > 0) {
        api.logger.info(
          `[linear] Pending issue work dispatch for ${reason}: attempted=${result.attempted} dispatched=${result.dispatched}`,
        );
        debugLog.append({
          type: "dispatcher.backlog_result",
          reason,
          attempted: result.attempted,
          dispatched: result.dispatched,
          decisions: result.decisions,
        });
      }
    } finally {
      dispatchBacklogInProgress = false;
    }
  };

  if (activeLeaseRecoveryInterval) clearInterval(activeLeaseRecoveryInterval);
  activeLeaseRecoveryInterval = setInterval(() => {
    try {
      const recovered = recoverExpiredLeases(false);
      dispatchPendingBacklog(recovered > 0 ? "periodic recovery" : "periodic scan").catch((err) => {
        api.logger.error(`[linear] Pending issue work dispatch failed: ${formatErrorMessage(err)}`);
      });
    } catch (err) {
      api.logger.error(`[linear] Issue work recovery failed: ${formatErrorMessage(err)}`);
    }
  }, 60_000);

  api.registerTool(createIssueWorkTool(issueWorkStore, {
    completeIssueWork: async (issueId) => issueWorkDispatcher.completeIssueWork(issueId),
    debugLogRoot: debugRoot,
  }));
  api.registerTool(createQueueTool(issueWorkStore, {
    completeIssueWork: async (issueId) => issueWorkDispatcher.completeIssueWork(issueId),
  }));
  api.registerTool(createIssueTool());
  api.registerTool(createCommentTool());
  api.registerTool(createTeamTool());
  api.registerTool(createProjectTool());
  api.registerTool(createRelationTool());

  // Auto-wake: after a "complete" action, dispatch remaining issue work back
  // to each owning issue session instead of a global queue session.
  api.on("after_tool_call", async (event) => {
    if (event.toolName !== "linear_queue" && event.toolName !== "linear_issue_work") return;
    if (event.params.action !== "complete") return;
    if (event.error) return;

    const remaining = await issueWorkStore.peek();
    if (remaining.length === 0) return;

    for (const item of remaining) {
      issueWorkDispatcher.dispatchPendingIssueWork(item.issueId).catch((err) => {
        api.logger.error(
          `[linear] Issue work wake failed for ${item.issueId}: ${formatErrorMessage(err)}`,
        );
      });
    }
  });

  const stateActions =
    (api.pluginConfig?.["stateActions"] as Record<string, string>) ?? undefined;

  const routeEvent = createEventRouter({
    agentMapping,
    defaultAgentId,
    logger: api.logger,
    eventFilter: eventFilter.length ? eventFilter : undefined,
    teamIds: teamIds.length ? teamIds : undefined,
    stateActions,
  });

  const debouncer = api.runtime.channel.debounce.createInboundDebouncer<RouterAction>({
    debounceMs,
    buildKey: (action) => action.identifier,
    shouldDebounce: () => true,
    onFlush: async (actions) => {
      // Group actions by issue identifier and dispatch each issue to its own session
      const byIssue = new Map<string, RouterAction[]>();
      for (const action of actions) {
        const key = action.identifier;
        const group = byIssue.get(key) ?? [];
        group.push(action);
        byIssue.set(key, group);
      }
      for (const issueActions of byIssue.values()) {
        await dispatchConsolidatedActions(issueActions, issueWorkDispatcher);
      }
    },
    onError: (err) => {
      api.logger.error(
        `[linear] Debounce flush failed: ${formatErrorMessage(err)}`,
      );
    },
  });
  activeDebouncer = debouncer;

  const handler = createWebhookHandler({
    webhookSecret,
    logger: api.logger,
    eventStore: webhookEventStore,
    onEvent: async (event) => {
      const normalized = normalizeLinearEvent(event, {
        openclawActorId,
        ignoredActorIds: ignoredNormalizerActorIds,
      });
      webhookEventStore.recordNormalizedDecision(normalized, event.createdAt);
      debugLog.append({
        type: "webhook.normalized",
        issueId: normalized.identifier ?? normalized.issueId ?? null,
        deliveryId: normalized.deliveryId ?? null,
        intent: normalized.intent,
        decision: normalized.action,
        reason: normalized.action === "ignore" ? normalized.reason : undefined,
        actorId: normalized.actorId,
        commentId: normalized.commentId,
        createdAt: event.createdAt,
      });
      if (normalized.action === "ignore") {
        api.logger.info(
          `[event-normalizer] ignored intent=${normalized.intent} issue=${normalized.identifier ?? normalized.issueId ?? "unknown"} reason=${normalized.reason}`,
        );
        return;
      }

      await reopenCompletedHumanFollowup(normalized, reopenState, api);

      const actions = routeEvent(event);
      for (const action of actions) {
        api.logger.info(
          `[event-router] ${action.type} agent=${action.agentId} event=${action.event}: ${action.detail}`,
        );

        if (action.type === "wake") {
          activeDebouncerKeys.add(action.identifier);
          debouncer.enqueue(action);
          debugLog.append({
            type: "router.wake",
            issueId: action.identifier,
            deliveryId: event.deliveryId ?? null,
            event: action.event,
            agentId: action.agentId,
          });
        }

        if (action.type === "notify") {
          debugLog.append({
            type: "router.notify",
            issueId: action.identifier,
            deliveryId: event.deliveryId ?? null,
            event: action.event,
            agentId: action.agentId,
          });
          issueWorkStore
            .enqueue([
              {
                id: action.commentId || action.identifier,
                issueId: action.identifier,
                event: action.event,
                summary: action.issueLabel,
                issuePriority: action.issuePriority,
              },
            ])
            .catch((err) =>
              api.logger.error(
                `[linear] Notify enqueue error: ${formatErrorMessage(err)}`,
              ),
            );
        }
      }
    },
  });

  api.registerHttpRoute({
    path: "/hooks/linear",
    handler,
    auth: "plugin",
  });

  api.logger.info(
    `Linear webhook handler registered at /hooks/linear (debounce: ${debounceMs}ms)`,
  );

  setTimeout(() => {
    dispatchPendingBacklog("startup recovery").catch((err) => {
      api.logger.error(`[linear] Startup pending issue work dispatch failed: ${formatErrorMessage(err)}`);
    });
  }, 1_000);
}

export async function deactivate(api: OpenClawPluginApi): Promise<void> {
  activeAssistantMirrorUnsubscribe?.();
  activeAssistantMirrorUnsubscribe = undefined;

  if (activeLeaseRecoveryInterval) {
    clearInterval(activeLeaseRecoveryInterval);
    activeLeaseRecoveryInterval = undefined;
  }

  if (activeDebouncer) {
    for (const key of activeDebouncerKeys) {
      await activeDebouncer.flushKey(key);
    }
    activeDebouncerKeys.clear();
    activeDebouncer = undefined;
  }
  api.logger.info("Linear plugin deactivated");
}

const plugin = {
  id: "openclaw-linear",
  name: "Linear",
  description: "Linear project management integration for OpenClaw",
  activate,
  deactivate,
} satisfies {
  id: string;
  name: string;
  description: string;
  activate: (api: OpenClawPluginApi) => void;
  deactivate: (api: OpenClawPluginApi) => Promise<void>;
};

export default plugin;
