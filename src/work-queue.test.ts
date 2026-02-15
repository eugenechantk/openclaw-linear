import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  InboxQueue,
  QUEUE_EVENT,
  type QueueItem,
  type EnqueueEntry,
} from "./work-queue.js";

const TMP_DIR = join(import.meta.dirname ?? __dirname, "../.test-tmp");
const QUEUE_PATH = join(TMP_DIR, "queue", "inbox.jsonl");

function readItems(): QueueItem[] {
  try {
    const content = readFileSync(QUEUE_PATH, "utf-8");
    return content
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as QueueItem);
  } catch {
    return [];
  }
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

// --- InboxQueue.enqueue ---

describe("InboxQueue.enqueue", () => {
  it("adds items to empty queue with issue priority", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    const added = await queue.enqueue([
      entry("ENG-42", "issue.assigned", "Fix login bug", 1),
    ]);
    expect(added).toBe(1);
    const items = readItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "ENG-42",
      event: "ticket",
      summary: "Fix login bug",
      priority: 1,
    });
  });

  it("maps no-priority (0) to sort last", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    await queue.enqueue([
      entry("ENG-1", "issue.assigned", "No priority task", 0),
      entry("ENG-2", "issue.assigned", "Low priority task", 4),
    ]);
    const items = await queue.peek();
    expect(items[0].id).toBe("ENG-2");
    expect(items[0].priority).toBe(4);
    expect(items[1].id).toBe("ENG-1");
    expect(items[1].priority).toBe(5);
  });

  it("deduplicates against existing items", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    await queue.enqueue([entry("ENG-42", "issue.assigned", "Fix login bug", 2)]);
    const added = await queue.enqueue([entry("ENG-42", "issue.assigned", "Fix login bug", 2)]);
    expect(added).toBe(0);
    expect(readItems()).toHaveLength(1);
  });

  it("allows same issue with different queue events", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    await queue.enqueue([entry("ENG-42", "issue.assigned", "Fix login bug", 2)]);
    const added = await queue.enqueue([entry("ENG-42", "comment.mention", "Fix login bug", 2)]);
    expect(added).toBe(1);
    const items = readItems();
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.event)).toEqual(["ticket", "mention"]);
  });

  it("deduplicates within the same batch", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    const added = await queue.enqueue([
      entry("ENG-42", "issue.assigned", "Fix login bug", 2),
      entry("ENG-42", "issue.assigned", "Fix login bug", 2),
    ]);
    expect(added).toBe(1);
  });

  it("returns 0 for empty entries", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    expect(await queue.enqueue([])).toBe(0);
  });

  it("uses issue priority for queue ordering", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    await queue.enqueue([
      entry("ENG-10", "comment.mention", "hey", 3),
      entry("ENG-11", "issue.assigned", "urgent fix", 1),
      entry("ENG-12", "issue.reassigned", "medium task", 3),
    ]);
    const items = readItems();
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.event)).toEqual(["mention", "ticket", "ticket"]);
    expect(items.map((i) => i.priority)).toEqual([3, 1, 3]);
  });
});

// --- InboxQueue.peek ---

describe("InboxQueue.peek", () => {
  it("returns empty array for empty queue", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    expect(await queue.peek()).toEqual([]);
  });

  it("returns items sorted by priority", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    await queue.enqueue([
      entry("ENG-10", "comment.mention", "hey", 4),
      entry("ENG-11", "issue.assigned", "urgent fix", 1),
      entry("ENG-12", "issue.reassigned", "medium task", 3),
    ]);

    const items = await queue.peek();
    expect(items.map((i) => i.id)).toEqual(["ENG-11", "ENG-12", "ENG-10"]);
    expect(items.map((i) => i.priority)).toEqual([1, 3, 4]);
  });

  it("does not remove items", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    await queue.enqueue([entry("ENG-42", "issue.assigned", "Fix login bug", 2)]);
    await queue.peek();
    await queue.peek();
    expect(readItems()).toHaveLength(1);
  });
});

// --- InboxQueue.pop ---

describe("InboxQueue.pop", () => {
  it("returns null for empty queue", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    expect(await queue.pop()).toBeNull();
  });

  it("removes and returns highest-priority item", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    await queue.enqueue([
      entry("ENG-10", "comment.mention", "hey", 4),
      entry("ENG-11", "issue.assigned", "urgent fix", 1),
    ]);

    const item = await queue.pop();
    expect(item!.id).toBe("ENG-11");
    expect(item!.event).toBe("ticket");
    expect(item!.priority).toBe(1);

    // Only the mention remains
    const remaining = readItems();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe("ENG-10");
    expect(remaining[0].event).toBe("mention");
  });

  it("returns items in priority order across multiple pops", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    await queue.enqueue([
      entry("ENG-10", "comment.mention", "hey", 4),
      entry("ENG-11", "issue.assigned", "urgent fix", 1),
      entry("ENG-12", "issue.reassigned", "medium task", 3),
    ]);

    expect((await queue.pop())!.id).toBe("ENG-11");
    expect((await queue.pop())!.id).toBe("ENG-12");
    expect((await queue.pop())!.id).toBe("ENG-10");
    expect(await queue.pop()).toBeNull();
  });
});

// --- InboxQueue.drain ---

describe("InboxQueue.drain", () => {
  it("returns empty array for empty queue", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    expect(await queue.drain()).toEqual([]);
  });

  it("removes and returns all items sorted by priority", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    await queue.enqueue([
      entry("ENG-10", "comment.mention", "hey", 4),
      entry("ENG-11", "issue.assigned", "urgent fix", 1),
    ]);

    const items = await queue.drain();
    expect(items.map((i) => i.id)).toEqual(["ENG-11", "ENG-10"]);

    // Queue is now empty
    expect(readItems()).toHaveLength(0);
    expect(await queue.peek()).toEqual([]);
  });
});

// --- Unassign removal ---

describe("InboxQueue unassign removal", () => {
  it("removes existing ticket for same issue", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    await queue.enqueue([entry("ENG-42", "issue.assigned", "Fix login bug", 2)]);
    expect(readItems()).toHaveLength(1);

    const added = await queue.enqueue([entry("ENG-42", "issue.unassigned", "Fix login bug", 2)]);
    expect(added).toBe(0);
    expect(readItems()).toHaveLength(0);
  });

  it("is a no-op on empty queue", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    const added = await queue.enqueue([entry("ENG-42", "issue.unassigned", "Fix login bug", 2)]);
    expect(added).toBe(0);
    expect(readItems()).toHaveLength(0);
  });

  it("does not affect mention items for same issue", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    await queue.enqueue([entry("ENG-42", "comment.mention", "hey", 2)]);
    expect(readItems()).toHaveLength(1);

    await queue.enqueue([entry("ENG-42", "issue.unassigned", "Fix login bug", 2)]);
    const items = readItems();
    expect(items).toHaveLength(1);
    expect(items[0].event).toBe("mention");
  });

  it("does not affect ticket items for different issues", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    await queue.enqueue([
      entry("ENG-42", "issue.assigned", "Fix login bug", 2),
      entry("ENG-43", "issue.assigned", "Update docs", 3),
    ]);

    await queue.enqueue([entry("ENG-42", "issue.unassigned", "Fix login bug", 2)]);
    const items = readItems();
    expect(items).toHaveLength(1);
    expect(items[0].issueId).toBe("ENG-43");
  });
});

// --- Reassigned dedup ---

describe("InboxQueue reassigned dedup", () => {
  it("deduplicates reassigned against existing ticket from assigned", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    await queue.enqueue([entry("ENG-42", "issue.assigned", "Fix login bug", 2)]);
    const added = await queue.enqueue([entry("ENG-42", "issue.reassigned", "Fix login bug", 2)]);
    expect(added).toBe(0);
    const items = readItems();
    expect(items).toHaveLength(1);
    expect(items[0].event).toBe("ticket");
  });
});

// --- QUEUE_EVENT mapping ---

describe("QUEUE_EVENT mapping", () => {
  it("maps raw events to queue events", () => {
    expect(QUEUE_EVENT["issue.assigned"]).toBe("ticket");
    expect(QUEUE_EVENT["issue.reassigned"]).toBe("ticket");
    expect(QUEUE_EVENT["comment.mention"]).toBe("mention");
    expect(QUEUE_EVENT["issue.unassigned"]).toBeUndefined();
  });
});

// --- Mutex serialization ---

describe("InboxQueue mutex serialization", () => {
  it("serializes concurrent enqueue calls", async () => {
    const queue = new InboxQueue(QUEUE_PATH);

    // Fire two enqueues concurrently — both should complete without data loss
    const [a, b] = await Promise.all([
      queue.enqueue([entry("ENG-1", "issue.assigned", "Task one", 2)]),
      queue.enqueue([entry("ENG-2", "issue.assigned", "Task two", 3)]),
    ]);

    expect(a + b).toBe(2);
    const items = readItems();
    expect(items).toHaveLength(2);
    const ids = items.map((i) => i.id).sort();
    expect(ids).toEqual(["ENG-1", "ENG-2"]);
  });

  it("serializes concurrent pop calls", async () => {
    const queue = new InboxQueue(QUEUE_PATH);
    await queue.enqueue([entry("ENG-1", "issue.assigned", "Task one", 2)]);
    await queue.enqueue([entry("ENG-2", "issue.assigned", "Task two", 3)]);

    const [a, b] = await Promise.all([queue.pop(), queue.pop()]);
    const results = [a, b].filter(Boolean);
    expect(results).toHaveLength(2);

    // Each item popped exactly once
    const ids = results.map((r) => r!.id).sort();
    expect(ids).toEqual(["ENG-1", "ENG-2"]);

    // Queue is now empty
    expect(await queue.pop()).toBeNull();
  });
});
