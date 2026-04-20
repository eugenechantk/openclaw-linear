import { describe, it, expect } from "vitest";
import { DEFAULT_OPENCLAW_ACTOR_ID, normalizeLinearEvent } from "../src/event-normalizer.js";
import type { LinearWebhookPayload } from "../src/webhook-handler.js";

describe("event-normalizer", () => {
  it("ignores comments authored by the configured OpenClaw actor", () => {
    const event: LinearWebhookPayload = {
      type: "Comment",
      action: "create",
      data: {
        id: "comment-openclaw",
        body: "Implemented the change.",
        user: { id: DEFAULT_OPENCLAW_ACTOR_ID, name: "OpenClaw" },
        issue: { id: "issue-1", identifier: "EUG-55" },
      },
      createdAt: "2026-04-19T00:00:00Z",
      deliveryId: "delivery-1",
    };

    expect(normalizeLinearEvent(event, { openclawActorId: DEFAULT_OPENCLAW_ACTOR_ID })).toMatchObject({
      action: "ignore",
      intent: "ignored_self_event",
      reason: "event authored by configured OpenClaw actor",
      issueId: "issue-1",
      identifier: "EUG-55",
      actorId: DEFAULT_OPENCLAW_ACTOR_ID,
      commentId: "comment-openclaw",
      deliveryId: "delivery-1",
    });
  });

  it("processes human comments as follow-up intent", () => {
    const event: LinearWebhookPayload = {
      type: "Comment",
      action: "create",
      data: {
        id: "comment-human",
        body: "This still fails with the keyboard open.",
        user: { id: "eugene-user", name: "Eugene Chan" },
        issue: { id: "issue-1", identifier: "EUG-55" },
      },
      createdAt: "2026-04-19T00:00:00Z",
    };

    expect(normalizeLinearEvent(event, { openclawActorId: DEFAULT_OPENCLAW_ACTOR_ID })).toMatchObject({
      action: "process",
      intent: "human_followup",
      issueId: "issue-1",
      identifier: "EUG-55",
      actorId: "eugene-user",
      commentId: "comment-human",
    });
  });

  it("processes issue creation as new issue assignment intent", () => {
    const event: LinearWebhookPayload = {
      type: "Issue",
      action: "create",
      data: {
        id: "issue-1",
        identifier: "EUG-55",
      },
      createdAt: "2026-04-19T00:00:00Z",
    };

    expect(normalizeLinearEvent(event)).toMatchObject({
      action: "process",
      intent: "new_issue_assignment",
      issueId: "issue-1",
      identifier: "EUG-55",
    });
  });
});

