import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { WebhookEventStore } from "../src/webhook-event-store.js";
import type { NormalizedEvent } from "../src/event-normalizer.js";

const TMP_DIR = join(import.meta.dirname ?? __dirname, "../.test-tmp-webhook-events");
const DB_PATH = join(TMP_DIR, "webhook-events.sqlite");

beforeEach(() => {
  mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

describe("WebhookEventStore", () => {
  it("records delivery IDs durably", () => {
    const store = new WebhookEventStore(DB_PATH);
    expect(store.insert({
      deliveryId: "delivery-1",
      action: "create",
      type: "Issue",
      issueId: "issue-1",
      rawBody: "{}",
    })).toEqual({ inserted: true });

    const restarted = new WebhookEventStore(DB_PATH);
    expect(restarted.has("delivery-1")).toBe(true);
    expect(restarted.insert({
      deliveryId: "delivery-1",
      action: "create",
      type: "Issue",
      issueId: "issue-1",
      rawBody: "{}",
    })).toEqual({ inserted: false, reason: "duplicate_delivery" });
  });

  it("records normalized process and ignore decisions", () => {
    const store = new WebhookEventStore(DB_PATH);
    const processEvent: NormalizedEvent = {
      action: "process",
      intent: "human_followup",
      deliveryId: "delivery-human",
      issueId: "issue-1",
      identifier: "EUG-55",
      commentId: "comment-human",
      actorId: "eugene-user",
    };
    const ignoredEvent: NormalizedEvent = {
      action: "ignore",
      intent: "ignored_self_event",
      reason: "event authored by configured OpenClaw actor",
      deliveryId: "delivery-openclaw",
      issueId: "issue-1",
      identifier: "EUG-55",
      commentId: "comment-openclaw",
      actorId: "openclaw-user",
    };

    store.recordNormalizedDecision(processEvent, "2026-04-19T00:00:00Z");
    store.recordNormalizedDecision(ignoredEvent, "2026-04-19T00:00:01Z");

    expect(store.listNormalizedEvents()).toEqual([
      {
        deliveryId: "delivery-human",
        issueId: "issue-1",
        identifier: "EUG-55",
        commentId: "comment-human",
        actorId: "eugene-user",
        intent: "human_followup",
        decision: "process",
        reason: null,
        createdAt: "2026-04-19T00:00:00Z",
      },
      {
        deliveryId: "delivery-openclaw",
        issueId: "issue-1",
        identifier: "EUG-55",
        commentId: "comment-openclaw",
        actorId: "openclaw-user",
        intent: "ignored_self_event",
        decision: "ignore",
        reason: "event authored by configured OpenClaw actor",
        createdAt: "2026-04-19T00:00:01Z",
      },
    ]);
  });
});
