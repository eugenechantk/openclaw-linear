import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createWebhookHandler } from "../src/webhook-handler.js";
import { createEventRouter, type RouterAction } from "../src/event-router.js";
import { InboxQueue, type QueueItem } from "../src/work-queue.js";

/**
 * Integration tests: webhook → event-router → queue
 *
 * These tests exercise the full pipeline end-to-end without the OpenClaw
 * runtime. A real webhook handler parses and verifies HTTP requests, the
 * event router decides what to do, and the queue persists items to disk.
 */

const SECRET = "integration-test-secret";
const AGENT_USER_ID = "user-agent-uuid";
const AGENT_ID = "scout";
const TMP_DIR = join(import.meta.dirname ?? __dirname, "../.test-tmp-integration");
const QUEUE_PATH = join(TMP_DIR, "queue", "inbox.jsonl");

// --- helpers ---

function sign(body: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

function makeReq(
  body: string,
  headers: Record<string, string> = {},
  method = "POST",
): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage;
  req.method = method;
  req.headers = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  process.nextTick(() => {
    req.emit("data", Buffer.from(body));
    req.emit("end");
  });
  return req;
}

function makeRes(): ServerResponse & { body: string; statusCode: number } {
  const res = {
    statusCode: 200,
    body: "",
    writeHead(code: number) { res.statusCode = code; },
    end(data?: string) { res.body = data ?? ""; },
  } as unknown as ServerResponse & { body: string; statusCode: number };
  return res;
}

function readQueueItems(): QueueItem[] {
  try {
    return readFileSync(QUEUE_PATH, "utf-8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as QueueItem);
  } catch {
    return [];
  }
}

function makePayload(overrides: Record<string, unknown> = {}) {
  return {
    action: "create",
    type: "Issue",
    data: {
      id: "issue-1",
      identifier: "ENG-42",
      title: "Fix login bug",
      priority: 1,
      assigneeId: AGENT_USER_ID,
      teamId: "team-1",
      team: { key: "ENG" },
      ...((overrides.data as Record<string, unknown>) ?? {}),
    },
    createdAt: "2026-01-01T00:00:00Z",
    ...Object.fromEntries(
      Object.entries(overrides).filter(([k]) => k !== "data"),
    ),
  };
}

// --- wiring ---

type Pipeline = {
  handler: ReturnType<typeof createWebhookHandler>;
  queue: InboxQueue;
  actions: RouterAction[];
  logger: { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
};

function buildPipeline(opts: {
  agentMapping?: Record<string, string>;
  eventFilter?: string[];
  teamIds?: string[];
  stateActions?: Record<string, string>;
} = {}): Pipeline {
  const logger = { info: vi.fn(), error: vi.fn() };
  const queue = new InboxQueue(QUEUE_PATH);
  const capturedActions: RouterAction[] = [];

  const routeEvent = createEventRouter({
    agentMapping: opts.agentMapping ?? { [AGENT_USER_ID]: AGENT_ID },
    logger,
    eventFilter: opts.eventFilter,
    teamIds: opts.teamIds,
    stateActions: opts.stateActions,
  });

  const handler = createWebhookHandler({
    webhookSecret: SECRET,
    logger,
    onEvent: (event) => {
      const actions = routeEvent(event);
      capturedActions.push(...actions);
      for (const action of actions) {
        if (action.type === "wake" || action.type === "notify") {
          queue.enqueue([{
            id: action.commentId || action.identifier,
            issueId: action.identifier,
            event: action.event,
            summary: action.issueLabel,
            issuePriority: action.issuePriority,
          }]);
        }
      }
    },
  });

  return { handler, queue, actions: capturedActions, logger };
}

async function postWebhook(
  pipeline: Pipeline,
  payload: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ statusCode: number; body: string }> {
  const body = JSON.stringify(payload);
  const req = makeReq(body, {
    "Linear-Signature": sign(body),
    ...headers,
  });
  const res = makeRes();
  await pipeline.handler(req, res);
  // Let any queued microtasks (enqueue promises) settle
  await new Promise((r) => setTimeout(r, 10));
  return { statusCode: res.statusCode, body: res.body };
}

// --- tests ---

beforeEach(() => {
  mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

describe("integration: webhook → router → queue", () => {
  it("issue.create with mapped assignee lands in queue", async () => {
    const pipeline = buildPipeline();
    const payload = makePayload();

    const res = await postWebhook(pipeline, payload);
    expect(res.statusCode).toBe(200);

    expect(pipeline.actions).toHaveLength(1);
    expect(pipeline.actions[0]).toMatchObject({
      type: "wake",
      agentId: AGENT_ID,
      event: "issue.assigned",
      identifier: "ENG-42",
    });

    const items = readQueueItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "ENG-42",
      event: "ticket",
      summary: "ENG-42: Fix login bug",
      status: "pending",
      priority: 1,
    });
  });

  it("issue.create with unmapped assignee produces no queue items", async () => {
    const pipeline = buildPipeline({ agentMapping: {} });
    const payload = makePayload();

    await postWebhook(pipeline, payload);

    expect(pipeline.actions).toHaveLength(0);
    expect(readQueueItems()).toHaveLength(0);
  });

  it("issue.update assignee change queues for new assignee", async () => {
    const pipeline = buildPipeline();
    const payload = makePayload({
      action: "update",
      data: {
        id: "issue-2",
        identifier: "ENG-99",
        title: "Refactor auth",
        priority: 2,
        assigneeId: AGENT_USER_ID,
      },
      updatedFrom: { assigneeId: null },
    });

    await postWebhook(pipeline, payload);

    expect(pipeline.actions).toHaveLength(1);
    expect(pipeline.actions[0].event).toBe("issue.assigned");

    const items = readQueueItems();
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("ENG-99");
  });

  it("issue.update state change to completed queues removal", async () => {
    const pipeline = buildPipeline();

    // First create the issue so it's in the queue
    await postWebhook(pipeline, makePayload());
    expect(readQueueItems()).toHaveLength(1);

    // State change to completed — should add a removal event
    const statePayload = makePayload({
      action: "update",
      data: {
        id: "issue-1",
        identifier: "ENG-42",
        title: "Fix login bug",
        priority: 1,
        assigneeId: AGENT_USER_ID,
        state: { type: "completed", name: "Done" },
        stateId: "state-done",
      },
      updatedFrom: { stateId: "state-old" },
    });

    await postWebhook(pipeline, statePayload);

    // The state_removed action should have removed the item from queue
    const items = readQueueItems();
    expect(items).toHaveLength(0);
  });

  it("comment mention queues a wake action with comment body", async () => {
    const pipeline = buildPipeline();
    const payload = {
      action: "create",
      type: "Comment",
      data: {
        id: "comment-1",
        body: `Hey @${AGENT_ID}, can you look at this?`,
        userId: "other-user",
        issue: {
          id: "issue-1",
          identifier: "ENG-42",
          title: "Fix login bug",
          priority: 1,
        },
      },
      createdAt: "2026-01-01T00:00:00Z",
    };

    await postWebhook(pipeline, payload);

    expect(pipeline.actions).toHaveLength(1);
    expect(pipeline.actions[0]).toMatchObject({
      type: "wake",
      event: "comment.mention",
      commentId: "comment-1",
    });

    const items = readQueueItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "comment-1",
      event: "mention",
    });
  });

  it("self-comment from mapped agent is skipped", async () => {
    const pipeline = buildPipeline();
    const payload = {
      action: "create",
      type: "Comment",
      data: {
        id: "comment-self",
        body: `@${AGENT_ID} done`,
        userId: AGENT_USER_ID,
        issue: { id: "issue-1", identifier: "ENG-42", title: "Fix login bug" },
      },
      createdAt: "2026-01-01T00:00:00Z",
    };

    await postWebhook(pipeline, payload);

    expect(pipeline.actions).toHaveLength(0);
    expect(readQueueItems()).toHaveLength(0);
  });

  it("duplicate webhook deliveries are deduped at the HTTP layer", async () => {
    const pipeline = buildPipeline();
    const payload = makePayload();
    const deliveryHeaders = { "Linear-Delivery": "delivery-123" };

    await postWebhook(pipeline, payload, deliveryHeaders);
    await postWebhook(pipeline, payload, deliveryHeaders);

    // Only 1 action + 1 queue item despite 2 deliveries
    expect(pipeline.actions).toHaveLength(1);
    expect(readQueueItems()).toHaveLength(1);
  });

  it("duplicate queue entries are deduped at the queue layer", async () => {
    const pipeline = buildPipeline();
    const payload = makePayload();

    // Use different delivery IDs so webhook layer lets both through
    await postWebhook(pipeline, payload, { "Linear-Delivery": "d-1" });
    await postWebhook(pipeline, payload, { "Linear-Delivery": "d-2" });

    // Router produces 2 actions, but queue deduplicates by issue identifier
    expect(pipeline.actions).toHaveLength(2);
    expect(readQueueItems()).toHaveLength(1);
  });

  it("event filter blocks non-matching event types", async () => {
    const pipeline = buildPipeline({ eventFilter: ["Comment"] });
    const payload = makePayload(); // type: "Issue"

    await postWebhook(pipeline, payload);

    expect(pipeline.actions).toHaveLength(0);
    expect(readQueueItems()).toHaveLength(0);
  });

  it("team filter blocks non-matching teams", async () => {
    const pipeline = buildPipeline({ teamIds: ["BACKEND"] });
    const payload = makePayload(); // team.key: "ENG"

    await postWebhook(pipeline, payload);

    expect(pipeline.actions).toHaveLength(0);
    expect(readQueueItems()).toHaveLength(0);
  });

  it("invalid signature is rejected before reaching router or queue", async () => {
    const pipeline = buildPipeline();
    const body = JSON.stringify(makePayload());
    const req = makeReq(body, { "Linear-Signature": "bad-sig" });
    const res = makeRes();

    await pipeline.handler(req, res);
    await new Promise((r) => setTimeout(r, 10));

    expect(res.statusCode).toBe(400);
    expect(pipeline.actions).toHaveLength(0);
    expect(readQueueItems()).toHaveLength(0);
  });

  it("full lifecycle: create → complete → verify empty queue", async () => {
    const pipeline = buildPipeline();

    // 1. Issue created and assigned
    await postWebhook(pipeline, makePayload());
    expect(readQueueItems()).toHaveLength(1);
    expect(readQueueItems()[0].status).toBe("pending");

    // 2. Agent pops the item (simulating tool call)
    const popped = await pipeline.queue.pop();
    expect(popped).toBeDefined();
    expect(popped!.id).toBe("ENG-42");

    // Verify it's now in_progress
    const inProgress = readQueueItems();
    expect(inProgress).toHaveLength(1);
    expect(inProgress[0].status).toBe("in_progress");

    // 3. Agent completes the item
    await pipeline.queue.complete(popped!.id);

    // 4. Queue is empty
    expect(readQueueItems()).toHaveLength(0);
    expect(await pipeline.queue.peek()).toHaveLength(0);
  });

  it("multiple events batch into queue with priority ordering", async () => {
    const pipeline = buildPipeline();

    // High-priority issue
    await postWebhook(pipeline, makePayload({
      data: { id: "issue-hi", identifier: "ENG-1", title: "P0 outage", priority: 1 },
    }), { "Linear-Delivery": "d-hi" });

    // Low-priority issue
    await postWebhook(pipeline, makePayload({
      data: { id: "issue-lo", identifier: "ENG-2", title: "Typo fix", priority: 4 },
    }), { "Linear-Delivery": "d-lo" });

    // Medium-priority issue
    await postWebhook(pipeline, makePayload({
      data: { id: "issue-med", identifier: "ENG-3", title: "Perf tweak", priority: 2 },
    }), { "Linear-Delivery": "d-med" });

    expect(pipeline.actions).toHaveLength(3);

    // Queue.peek returns items sorted by priority (1 = urgent, 4 = low)
    const peeked = await pipeline.queue.peek();
    expect(peeked).toHaveLength(3);
    expect(peeked[0].id).toBe("ENG-1");
    expect(peeked[1].id).toBe("ENG-3");
    expect(peeked[2].id).toBe("ENG-2");
  });

  it("reassignment removes from old assignee queue", async () => {
    const oldUser = "user-old";
    const pipeline = buildPipeline({
      agentMapping: {
        [AGENT_USER_ID]: AGENT_ID,
        [oldUser]: "titus",
      },
    });

    // First assign to old user
    await postWebhook(pipeline, makePayload({
      data: { id: "issue-1", identifier: "ENG-50", title: "Task", priority: 2, assigneeId: oldUser },
    }), { "Linear-Delivery": "d-assign" });

    expect(readQueueItems()).toHaveLength(1);
    expect(readQueueItems()[0].id).toBe("ENG-50");

    // Reassign to new user
    await postWebhook(pipeline, makePayload({
      action: "update",
      data: {
        id: "issue-1",
        identifier: "ENG-50",
        title: "Task",
        priority: 2,
        assigneeId: AGENT_USER_ID,
      },
      updatedFrom: { assigneeId: oldUser },
    }), { "Linear-Delivery": "d-reassign" });

    // Should have a wake for new + notify for old
    const wakes = pipeline.actions.filter((a) => a.event === "issue.assigned");
    const reassigns = pipeline.actions.filter((a) => a.event === "issue.reassigned");
    expect(wakes).toHaveLength(2); // original + new
    expect(reassigns).toHaveLength(1);
  });

  it("custom stateActions override default behavior", async () => {
    const pipeline = buildPipeline({
      stateActions: { "In Review": "add", triage: "add" },
    });

    // Triage normally = ignore, but custom says add
    const payload = makePayload({
      action: "update",
      data: {
        id: "issue-1",
        identifier: "ENG-42",
        title: "Fix login bug",
        priority: 1,
        assigneeId: AGENT_USER_ID,
        state: { type: "triage", name: "Triage" },
        stateId: "state-triage",
      },
      updatedFrom: { stateId: "state-old" },
    });

    await postWebhook(pipeline, payload);

    // Custom config maps triage → "add", so we should get a state_readded action
    const stateActions = pipeline.actions.filter(
      (a) => a.event === "issue.state_readded" || a.event === "issue.state_removed",
    );
    expect(stateActions).toHaveLength(1);
    expect(stateActions[0].event).toBe("issue.state_readded");
  });

  it("comment with ProseMirror bodyData resolves mentions by UUID", async () => {
    const pipeline = buildPipeline();
    const payload = {
      action: "create",
      type: "Comment",
      data: {
        id: "comment-pm",
        body: "Hey check this out",
        bodyData: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                { type: "mention", attrs: { id: AGENT_USER_ID, label: "Scout" } },
                { type: "text", text: " check this out" },
              ],
            },
          ],
        },
        userId: "other-user",
        issue: { id: "issue-1", identifier: "ENG-42", title: "Fix login bug", priority: 1 },
      },
      createdAt: "2026-01-01T00:00:00Z",
    };

    await postWebhook(pipeline, payload);

    expect(pipeline.actions).toHaveLength(1);
    expect(pipeline.actions[0].event).toBe("comment.mention");
    expect(readQueueItems()).toHaveLength(1);
  });

  it("queue crash recovery resets in_progress items to pending", async () => {
    const pipeline = buildPipeline();

    // Create and pop an item (simulates an agent crash mid-processing)
    await postWebhook(pipeline, makePayload());
    await pipeline.queue.pop();
    expect(readQueueItems()[0].status).toBe("in_progress");

    // Simulate restart: new queue instance runs recover()
    const freshQueue = new InboxQueue(QUEUE_PATH);
    const recovered = await freshQueue.recover();
    expect(recovered).toBe(1);

    const items = readQueueItems();
    expect(items).toHaveLength(1);
    expect(items[0].status).toBe("pending");
  });
});
