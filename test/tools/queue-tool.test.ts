import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { InboxQueue, type EnqueueEntry } from "../../src/work-queue.js";

vi.mock("openclaw/plugin-sdk/agent-runtime", () => ({
  jsonResult: (data: unknown) => ({
    content: [{ type: "text", text: JSON.stringify(data) }],
  }),
  stringEnum: (values: readonly string[]) => ({ enum: values }),
}));

import { createQueueTool } from "../../src/tools/queue-tool.js";

const TMP_DIR = join(import.meta.dirname ?? __dirname, "../../.test-tmp-tool");
const QUEUE_PATH = join(TMP_DIR, "queue", "inbox.jsonl");

function parse(result: { content: { type: string; text?: string }[] }) {
  const text = result.content.find((c) => c.type === "text")?.text;
  return text ? JSON.parse(text) : undefined;
}

function entry(
  id: string,
  event: string,
  summary: string,
  issuePriority = 0,
): EnqueueEntry {
  return { id, event, summary, issuePriority };
}

beforeEach(() => {
  mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

describe("linear_queue tool", () => {
  it("has correct name and description", () => {
    const queue = new InboxQueue(QUEUE_PATH);
    const tool = createQueueTool(queue);
    expect(tool.name).toBe("linear_queue");
    expect(tool.description).toContain("peek");
    expect(tool.description).toContain("claim");
    expect(tool.description).toContain("pop");
    expect(tool.description).toContain("drain");
    expect(tool.description).toContain("complete");
  });

  it("peek returns empty items on empty queue", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    const tool = createQueueTool(queue);
    const result = await tool.execute("call-1", { action: "peek" });
    const data = parse(result);
    expect(data.count).toBe(0);
    expect(data.items).toEqual([]);
  });

  it("pop returns null item on empty queue", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    const tool = createQueueTool(queue);
    const result = await tool.execute("call-1", { action: "pop" });
    const data = parse(result);
    expect(data.item).toBeNull();
    expect(data.message).toBe("Queue is empty");
  });

  it("claim returns null item on empty queue", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    const tool = createQueueTool(queue);
    const result = await tool.execute("call-1", { action: "claim", issueId: "ENG-42" });
    const data = parse(result);
    expect(data.item).toBeNull();
    expect(data.issueId).toBe("ENG-42");
    expect(data.message).toBe("No pending item for issue");
  });

  it("drain returns empty items on empty queue", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    const tool = createQueueTool(queue);
    const result = await tool.execute("call-1", { action: "drain" });
    const data = parse(result);
    expect(data.count).toBe(0);
    expect(data.items).toEqual([]);
  });

  it("peek returns items after enqueue", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    await queue.enqueue([entry("ENG-42", "issue.assigned", "Fix login bug", 2)]);
    const tool = createQueueTool(queue);

    const result = await tool.execute("call-1", { action: "peek" });
    const data = parse(result);
    expect(data.count).toBe(1);
    expect(data.items[0].id).toBe("ENG-42");
  });

  it("pop claims and returns item", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    await queue.enqueue([entry("ENG-42", "issue.assigned", "Fix login bug", 2)]);
    const tool = createQueueTool(queue);

    const result = await tool.execute("call-1", { action: "pop" });
    const data = parse(result);
    expect(data.item.id).toBe("ENG-42");
    expect(data.item.status).toBe("in_progress");

    // No pending items left (but item still on disk as in_progress)
    const peek = await tool.execute("call-2", { action: "peek" });
    expect(parse(peek).count).toBe(0);
  });

  it("claim claims and returns only the requested issue item", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    await queue.enqueue([
      entry("ENG-43", "issue.assigned", "Other issue", 1),
      entry("ENG-42", "issue.assigned", "Target issue", 3),
    ]);
    const tool = createQueueTool(queue);

    const result = await tool.execute("call-1", { action: "claim", issueId: "ENG-42" });
    const data = parse(result);
    expect(data.item.id).toBe("ENG-42");
    expect(data.item.status).toBe("in_progress");

    const peek = await tool.execute("call-2", { action: "peek" });
    const pending = parse(peek).items;
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe("ENG-43");
  });

  it("claim without issueId returns error", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    const tool = createQueueTool(queue);
    const result = await tool.execute("call-1", { action: "claim" });
    const data = parse(result);
    expect(data.error).toContain("issueId is required");
  });

  it("drain claims all items", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    await queue.enqueue([
      entry("ENG-1", "issue.assigned", "Task one", 2),
      entry("ENG-2", "issue.assigned", "Task two", 3),
    ]);
    const tool = createQueueTool(queue);

    const result = await tool.execute("call-1", { action: "drain" });
    const data = parse(result);
    expect(data.count).toBe(2);

    // No pending items left
    const peek = await tool.execute("call-2", { action: "peek" });
    expect(parse(peek).count).toBe(0);
  });

  it("complete action calls queue.complete and returns success", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    await queue.enqueue([entry("ENG-42", "issue.assigned", "Fix bug", 2)]);
    await queue.pop(); // claim it

    const tool = createQueueTool(queue);
    const result = await tool.execute("call-1", { action: "complete", issueId: "ENG-42" });
    const data = parse(result);
    expect(data.completed).toBe(true);
    expect(data.issueId).toBe("ENG-42");
    expect(data.remaining).toBe(0);
  });

  it("complete action can delegate completion to the issue work dispatcher", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    const completeIssueWork = vi.fn(async () => ({
      type: "completed",
      issueId: "ENG-42",
      transition: "in_review",
    }));
    await queue.enqueue([entry("ENG-99", "issue.assigned", "Other bug", 2)]);

    const tool = createQueueTool(queue, { completeIssueWork });
    const result = await tool.execute("call-1", { action: "complete", issueId: "ENG-42" });
    const data = parse(result);

    expect(completeIssueWork).toHaveBeenCalledWith("ENG-42");
    expect(data.completed).toBe(true);
    expect(data.issueId).toBe("ENG-42");
    expect(data.remaining).toBe(1);
    expect(data.decision).toMatchObject({
      type: "completed",
      issueId: "ENG-42",
      transition: "in_review",
    });
  });

  it("complete action reports not completed dispatcher decisions", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    const completeIssueWork = vi.fn(async () => ({
      type: "not_completed",
      issueId: "ENG-42",
      reason: "codex_still_running",
    }));

    const tool = createQueueTool(queue, { completeIssueWork });
    const result = await tool.execute("call-1", { action: "complete", issueId: "ENG-42" });
    const data = parse(result);

    expect(data.completed).toBe(false);
    expect(data.decision).toMatchObject({
      type: "not_completed",
      issueId: "ENG-42",
      reason: "codex_still_running",
    });
  });

  it("complete without issueId returns error", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    const tool = createQueueTool(queue);
    const result = await tool.execute("call-1", { action: "complete" });
    const data = parse(result);
    expect(data.error).toContain("issueId is required");
  });

  it("returns error for unknown action", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    const tool = createQueueTool(queue);
    const result = await tool.execute("call-1", { action: "invalid" as any });
    const data = parse(result);
    expect(data.error).toContain("Unknown action");
  });
});
