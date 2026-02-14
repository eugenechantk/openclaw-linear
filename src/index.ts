import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { LinearClient } from "@linear/sdk";
import { createWebhookHandler } from "./webhook-handler.js";
import { createEventRouter, type RouterAction } from "./event-router.js";
import { createLinearClient } from "./linear-client.js";
import { registerCreateIssueTool } from "./tools/create-issue.js";
import { registerListIssuesTool } from "./tools/list-issues.js";
import { registerUpdateIssueTool } from "./tools/update-issue.js";
import { registerAddCommentTool } from "./tools/add-comment.js";

const CHANNEL_ID = "linear";

async function dispatchAction(
  action: RouterAction,
  api: OpenClawPluginApi,
  linearClient?: LinearClient,
): Promise<void> {
  const core = api.runtime;
  const cfg = api.config;

  const route = core.channel.routing.resolveAgentRoute({
    cfg,
    channel: CHANNEL_ID,
    accountId: "default",
    peer: {
      kind: "direct" as const,
      id: action.linearUserId,
    },
  });

  const body = action.detail;

  const ctx = core.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: body,
    RawBody: body,
    CommandBody: body,
    From: `${CHANNEL_ID}:${action.linearUserId}`,
    To: `${CHANNEL_ID}:${route.agentId ?? action.agentId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId ?? "default",
    ChatType: "direct",
    ConversationLabel: `Linear: ${action.event} (${action.issueId})`,
    SenderId: action.linearUserId,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `${CHANNEL_ID}:${action.linearUserId}`,
  });

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx,
    cfg,
    dispatcherOptions: {
      deliver: async (payload) => {
        const rp = payload as { text?: string };
        if (linearClient && rp.text && action.issueId !== "unknown") {
          try {
            await linearClient.createComment({
              issueId: action.issueId,
              body: rp.text,
            });
          } catch (err) {
            api.logger.error(
              `[linear] Failed to post reply comment: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
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

  // Register agent tools if API key is available
  const apiKey = api.pluginConfig?.["apiKey"] as string | undefined;
  let linearClient: LinearClient | undefined;
  if (apiKey) {
    linearClient = createLinearClient(apiKey);
    registerCreateIssueTool(api, linearClient);
    registerListIssuesTool(api, linearClient);
    registerUpdateIssueTool(api, linearClient);
    registerAddCommentTool(api, linearClient);
    api.logger.info("Linear agent tools registered (4 tools)");
  }

  const webhookSecret = api.pluginConfig?.["webhookSecret"];
  if (typeof webhookSecret === "string" && webhookSecret) {
    const agentMapping =
      (api.pluginConfig?.["agentMapping"] as Record<string, string>) ?? {};
    const eventFilter =
      (api.pluginConfig?.["eventFilter"] as string[]) ?? [];
    const teamIds =
      (api.pluginConfig?.["teamIds"] as string[]) ?? [];

    const route = createEventRouter({
      agentMapping,
      logger: api.logger,
      eventFilter: eventFilter.length ? eventFilter : undefined,
      teamIds: teamIds.length ? teamIds : undefined,
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
            dispatchAction(action, api, linearClient).catch((err) => {
              api.logger.error(
                `[linear] Dispatch failed for ${action.event} → ${action.agentId}: ${err instanceof Error ? err.message : String(err)}`,
              );
            });
          }
        }
      },
    });

    api.registerHttpRoute({
      path: "/hooks/linear",
      handler,
    });

    api.logger.info("Linear webhook handler registered at /hooks/linear");
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
