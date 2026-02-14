import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createWebhookHandler } from "./webhook-handler.js";
import { createEventRouter, type RouterAction } from "./event-router.js";

const CHANNEL_ID = "linear";
const DEFAULT_DEBOUNCE_MS = 30_000;

const EVENT_LABELS: Record<string, string> = {
  "issue.assigned": "Assigned",
  "issue.unassigned": "Unassigned",
  "issue.reassigned": "Reassigned",
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
  switch (action.event) {
    case "comment.mention": {
      // detail format: "Mentioned in comment on issue LABEL\n\n> body"
      const bodyStart = action.detail.indexOf("\n\n> ");
      if (bodyStart !== -1) {
        const issueInfo = action.detail.slice("Mentioned in comment on issue ".length, bodyStart);
        const quote = action.detail.slice(bodyStart + 4); // skip "\n\n> "
        return `${issueInfo}: "${quote}"`;
      }
      return action.detail;
    }
    case "issue.assigned":
      // detail format: "Assigned to issue LABEL"
      return action.detail.slice("Assigned to issue ".length);
    case "issue.unassigned":
      return action.detail.slice("Unassigned from issue ".length);
    case "issue.reassigned":
      return action.detail.slice("Reassigned away from issue ".length);
    default:
      return action.detail;
  }
}

async function dispatchConsolidatedActions(
  actions: RouterAction[],
  api: OpenClawPluginApi,
): Promise<void> {
  if (actions.length === 0) return;

  const core = api.runtime;
  const cfg = api.config;

  const first = actions[0];

  const route = core.channel.routing.resolveAgentRoute({
    cfg,
    channel: CHANNEL_ID,
    accountId: "default",
    peer: {
      kind: "direct" as const,
      id: first.linearUserId,
    },
  });

  const body = formatConsolidatedMessage(actions);

  const ctx = core.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: body,
    RawBody: body,
    CommandBody: body,
    From: `${CHANNEL_ID}:${first.linearUserId}`,
    To: `${CHANNEL_ID}:${route.agentId ?? first.agentId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId ?? "default",
    ChatType: "direct",
    ConversationLabel: `Linear: batch (${actions.length} events)`,
    SenderId: first.linearUserId,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `${CHANNEL_ID}:${first.linearUserId}`,
  });

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx,
    cfg,
    dispatcherOptions: {
      deliver: async () => {
        // No-op: agent uses Linear tools to respond to specific issues after triage
      },
      onError: (err: unknown) => {
        api.logger.error(
          `[linear] Reply error: ${err instanceof Error ? err.message : String(err)}`,
        );
      },
    },
  });
}

export function activate(api: OpenClawPluginApi): void {
  api.logger.info("Linear plugin activated");

  const webhookSecret = api.pluginConfig?.["webhookSecret"];
  if (typeof webhookSecret === "string" && webhookSecret) {
    const agentMapping =
      (api.pluginConfig?.["agentMapping"] as Record<string, string>) ?? {};
    const eventFilter =
      (api.pluginConfig?.["eventFilter"] as string[]) ?? [];
    const teamIds =
      (api.pluginConfig?.["teamIds"] as string[]) ?? [];
    const debounceMs =
      (api.pluginConfig?.["debounceMs"] as number | undefined) ?? DEFAULT_DEBOUNCE_MS;

    const route = createEventRouter({
      agentMapping,
      logger: api.logger,
      eventFilter: eventFilter.length ? eventFilter : undefined,
      teamIds: teamIds.length ? teamIds : undefined,
    });

    const debouncer = api.runtime.channel.debounce.createInboundDebouncer<RouterAction>({
      debounceMs,
      buildKey: (action) => action.agentId,
      shouldDebounce: () => true,
      onFlush: async (actions) => {
        await dispatchConsolidatedActions(actions, api);
      },
      onError: (err) => {
        api.logger.error(
          `[linear] Debounce flush failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      },
    });

    const handler = createWebhookHandler({
      webhookSecret,
      logger: api.logger,
      onEvent: (event) => {
        const actions = route(event);
        for (const action of actions) {
          api.logger.info(
            `[event-router] ${action.type} agent=${action.agentId} event=${action.event}: ${action.detail}`,
          );

          if (action.type === "wake") {
            debouncer.enqueue(action);
          }
        }
      },
    });

    api.registerHttpRoute({
      path: "/hooks/linear",
      handler,
    });

    api.logger.info(
      `Linear webhook handler registered at /hooks/linear (debounce: ${debounceMs}ms)`,
    );
  }
}

export function deactivate(api: OpenClawPluginApi): void {
  api.logger.info("Linear plugin deactivated");
}

const plugin = {
  id: "linear",
  name: "Linear",
  description: "Linear project management integration for OpenClaw",
  activate,
} satisfies {
  id: string;
  name: string;
  description: string;
  activate: (api: OpenClawPluginApi) => void;
};

export default plugin;
