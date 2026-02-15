import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { InboxQueue, type EnqueueEntry } from "./work-queue.js";
import { createQueueTool } from "./queue-tool.js";

const TMP_DIR = join(import.meta.dirname ?? __dirname, "../.test-tmp-tool");
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
    expect(tool.description).toContain("pop");
    expect(tool.description).toContain("drain");
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

  it("pop removes and returns item", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    await queue.enqueue([entry("ENG-42", "issue.assigned", "Fix login bug", 2)]);
    const tool = createQueueTool(queue);

    const result = await tool.execute("call-1", { action: "pop" });
    const data = parse(result);
    expect(data.item.id).toBe("ENG-42");

    // Queue is now empty
    const peek = await tool.execute("call-2", { action: "peek" });
    expect(parse(peek).count).toBe(0);
  });

  it("drain removes all items", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    await queue.enqueue([
      entry("ENG-1", "issue.assigned", "Task one", 2),
      entry("ENG-2", "issue.assigned", "Task two", 3),
    ]);
    const tool = createQueueTool(queue);

    const result = await tool.execute("call-1", { action: "drain" });
    const data = parse(result);
    expect(data.count).toBe(2);

    // Queue is now empty
    const peek = await tool.execute("call-2", { action: "peek" });
    expect(parse(peek).count).toBe(0);
  });

  it("returns error for unknown action", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    const tool = createQueueTool(queue);
    const result = await tool.execute("call-1", { action: "invalid" as any });
    const data = parse(result);
    expect(data.error).toContain("Unknown action");
  });
});
