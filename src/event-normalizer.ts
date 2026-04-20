import type { LinearWebhookPayload } from "./webhook-handler.js";

export const DEFAULT_OPENCLAW_ACTOR_ID = "e763c867-5ee2-49a7-88e2-282d958eff4a";

export type NormalizedIntent =
  | "new_issue_assignment"
  | "human_followup"
  | "issue_update"
  | "ignored_self_event"
  | "non_actionable_event";

export type NormalizedEvent =
  | {
      action: "process";
      intent: NormalizedIntent;
      issueId?: string;
      identifier?: string;
      actorId?: string;
      commentId?: string;
      deliveryId?: string;
    }
  | {
      action: "ignore";
      intent: NormalizedIntent;
      reason: string;
      issueId?: string;
      identifier?: string;
      actorId?: string;
      commentId?: string;
      deliveryId?: string;
    };

export type EventNormalizerConfig = {
  openclawActorId?: string;
  ignoredActorIds?: string[];
};

function actorIdForEvent(event: LinearWebhookPayload): string | undefined {
  const user = event.data.user as Record<string, unknown> | undefined;
  return (user?.id as string | undefined)
    ?? (event.data.userId as string | undefined)
    ?? (event.data.actorId as string | undefined);
}

function issueRefForEvent(event: LinearWebhookPayload): Record<string, unknown> | undefined {
  return event.data.issue as Record<string, unknown> | undefined;
}

function issueIdForEvent(event: LinearWebhookPayload): string | undefined {
  const issueRef = issueRefForEvent(event);
  const value = issueRef?.id ?? event.data.issueId ?? event.data.id;
  return typeof value === "string" ? value : undefined;
}

function identifierForEvent(event: LinearWebhookPayload): string | undefined {
  const issueRef = issueRefForEvent(event);
  const value = issueRef?.identifier ?? event.data.identifier;
  return typeof value === "string" ? value : undefined;
}

function ignoredActors(config: EventNormalizerConfig): Set<string> {
  const ids = new Set<string>();
  if (config.openclawActorId) ids.add(config.openclawActorId);
  for (const id of config.ignoredActorIds ?? []) {
    if (id) ids.add(id);
  }
  return ids;
}

export function normalizeLinearEvent(
  event: LinearWebhookPayload,
  config: EventNormalizerConfig = {},
): NormalizedEvent {
  const actorId = actorIdForEvent(event);
  const issueId = issueIdForEvent(event);
  const identifier = identifierForEvent(event);
  const commentId = event.type === "Comment" ? String(event.data.id ?? "") || undefined : undefined;
  const deliveryId = event.deliveryId;

  if (actorId && ignoredActors(config).has(actorId)) {
    return {
      action: "ignore",
      intent: "ignored_self_event",
      reason: "event authored by configured OpenClaw actor",
      issueId,
      identifier,
      actorId,
      commentId,
      deliveryId,
    };
  }

  if (event.type === "Comment") {
    return {
      action: "process",
      intent: "human_followup",
      issueId,
      identifier,
      actorId,
      commentId,
      deliveryId,
    };
  }

  if (event.type === "Issue" && event.action === "create") {
    return {
      action: "process",
      intent: "new_issue_assignment",
      issueId,
      identifier,
      actorId,
      deliveryId,
    };
  }

  if (event.type === "Issue" && event.action === "update") {
    return {
      action: "process",
      intent: "issue_update",
      issueId,
      identifier,
      actorId,
      deliveryId,
    };
  }

  return {
    action: "ignore",
    intent: "non_actionable_event",
    reason: `unsupported event ${event.action} ${event.type}`,
    issueId,
    identifier,
    actorId,
    deliveryId,
  };
}

