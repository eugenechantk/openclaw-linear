import type { LinearWebhookPayload } from "./webhook-handler.js";

export type RouterAction = {
  type: "wake" | "notify";
  agentId: string;
  event: string;
  detail: string;
  issueId: string;
  issueLabel: string;
  identifier: string;
  issuePriority: number;
  linearUserId: string;
};

export type EventRouterConfig = {
  agentMapping: Record<string, string>;
  logger: {
    info: (message: string) => void;
    error: (message: string) => void;
  };
  eventFilter?: string[];
  teamIds?: string[];
};

/**
 * Extract mention user IDs from ProseMirror bodyData JSON.
 * Traverses the document tree looking for "mention" nodes with an `attrs.id`.
 */
function extractMentionsFromProseMirror(node: unknown): string[] {
  if (!node || typeof node !== "object") return [];
  const n = node as Record<string, unknown>;
  const ids: string[] = [];

  if (n.type === "mention") {
    const attrs = n.attrs as Record<string, unknown> | undefined;
    const id = attrs?.id;
    if (typeof id === "string" && id) {
      ids.push(id);
    }
  }

  const content = n.content;
  if (Array.isArray(content)) {
    for (const child of content) {
      ids.push(...extractMentionsFromProseMirror(child));
    }
  }

  return ids;
}

/**
 * Extract mentioned user identifiers from a comment.
 * Tries structured ProseMirror bodyData first (yields UUIDs), then
 * falls back to regex on the markdown body (yields usernames/handles).
 */
function extractMentionedUserIds(
  body: string,
  bodyData?: unknown,
): string[] {
  if (bodyData) {
    const ids = extractMentionsFromProseMirror(bodyData);
    if (ids.length > 0) return [...new Set(ids)];
  }

  const matches = body.matchAll(/@([a-zA-Z0-9_.-]+)/g);
  return [...new Set([...matches].map((m) => m[1]))];
}

function resolveIssueLabel(data: Record<string, unknown>): string {
  const identifier = data.identifier as string | undefined;
  const title = data.title as string | undefined;
  const id = String(data.id ?? "unknown");

  const label = identifier ?? id;
  return title ? `${label}: ${title}` : label;
}

function handleIssueUpdate(
  event: LinearWebhookPayload,
  config: EventRouterConfig,
): RouterAction[] {
  const changes = event.data.changes as
    | Record<string, { from?: unknown; to?: unknown }>
    | undefined;
  if (!changes?.assigneeId) return [];

  const actions: RouterAction[] = [];
  const { from: oldAssignee, to: newAssignee } = changes.assigneeId as {
    from?: string;
    to?: string;
  };
  const issueId = String(event.data.id ?? "unknown");
  const issueLabel = resolveIssueLabel(event.data);
  const identifier = (event.data.identifier as string) ?? issueId;
  const issuePriority = (event.data.priority as number) ?? 0;

  if (newAssignee) {
    const agentId = config.agentMapping[newAssignee];
    if (agentId) {
      actions.push({
        type: "wake",
        agentId,
        event: "issue.assigned",
        detail: `Assigned to issue ${issueLabel}`,
        issueId,
        issueLabel,
        identifier,
        issuePriority,
        linearUserId: newAssignee,
      });
    } else {
      config.logger.info(
        `Unmapped Linear user ${newAssignee} assigned to ${issueId}`,
      );
    }
  }

  if (oldAssignee && !newAssignee) {
    const agentId = config.agentMapping[oldAssignee];
    if (agentId) {
      actions.push({
        type: "notify",
        agentId,
        event: "issue.unassigned",
        detail: `Unassigned from issue ${issueLabel}`,
        issueId,
        issueLabel,
        identifier,
        issuePriority,
        linearUserId: oldAssignee,
      });
    } else {
      config.logger.info(
        `Unmapped Linear user ${oldAssignee} unassigned from ${issueId}`,
      );
    }
  }

  // Reassignment: both old and new assignee present — notify old assignee
  if (oldAssignee && newAssignee) {
    const agentId = config.agentMapping[oldAssignee];
    if (agentId) {
      actions.push({
        type: "notify",
        agentId,
        event: "issue.reassigned",
        detail: `Reassigned away from issue ${issueLabel}`,
        issueId,
        issueLabel,
        identifier,
        issuePriority,
        linearUserId: oldAssignee,
      });
    }
  }

  return actions;
}

function handleComment(
  event: LinearWebhookPayload,
  config: EventRouterConfig,
): RouterAction[] {
  const body = event.data.body as string | undefined;
  if (!body) return [];

  const bodyData = event.data.bodyData;
  const mentionedIds = extractMentionedUserIds(body, bodyData);
  const actions: RouterAction[] = [];

  const issueRef = event.data.issue as Record<string, unknown> | undefined;
  const issueId = String(issueRef?.id ?? event.data.issueId ?? "unknown");
  const issueLabel = issueRef
    ? resolveIssueLabel(issueRef)
    : issueId;
  const identifier = (issueRef?.identifier as string) ?? issueId;
  const issuePriority = (issueRef?.priority as number) ?? 0;

  for (const userId of mentionedIds) {
    const agentId = config.agentMapping[userId];
    if (agentId) {
      actions.push({
        type: "wake",
        agentId,
        event: "comment.mention",
        detail: `Mentioned in comment on issue ${issueLabel}\n\n> ${body}`,
        issueId,
        issueLabel,
        identifier,
        issuePriority,
        linearUserId: userId,
      });
    } else {
      config.logger.info(
        `Unmapped Linear user ${userId} mentioned in comment on ${issueId}`,
      );
    }
  }

  return actions;
}

export function createEventRouter(config: EventRouterConfig) {
  return function route(event: LinearWebhookPayload): RouterAction[] {
    // Apply event type filter
    if (
      config.eventFilter?.length &&
      !config.eventFilter.includes(event.type)
    ) {
      return [];
    }

    // Apply team filter
    const teamId = event.data.teamId as string | undefined;
    const teamObj = event.data.team as Record<string, unknown> | undefined;
    const teamKey = teamObj?.key as string | undefined;
    if (config.teamIds?.length) {
      const match = config.teamIds.some(
        (t) => t === teamId || t === teamKey,
      );
      if (!match && (teamId || teamKey)) return [];
    }

    if (event.type === "Issue" && event.action === "update") {
      return handleIssueUpdate(event, config);
    }

    if (
      event.type === "Comment" &&
      (event.action === "create" || event.action === "update")
    ) {
      return handleComment(event, config);
    }

    return [];
  };
}
