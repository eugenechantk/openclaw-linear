import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseNotificationMessage,
  readQueue,
  writeQueue,
  handleIntake,
  handleRecovery,
  cleanupDoneItems,
  type WorkQueue,
  type QueueItem,
} from "./work-queue.js";

const TMP_DIR = join(import.meta.dirname ?? __dirname, "../.test-tmp");
const QUEUE_PATH = join(TMP_DIR, "queue", "work-queue.json");

function seedQueue(items: QueueItem[]): void {
  const dir = join(TMP_DIR, "queue");
  mkdirSync(dir, { recursive: true });
  writeFileSync(QUEUE_PATH, JSON.stringify({ items }, null, 2) + "\n");
}

function makeItem(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: "ENG-1",
    issueId: "ENG-1",
    event: "issue.assigned",
    summary: "Test item",
    status: "pending",
    priority: 1,
    addedAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

// --- parseNotificationMessage ---

describe("parseNotificationMessage", () => {
  it("parses single assigned notification", () => {
    const result = parseNotificationMessage("Assigned to issue ENG-42: Fix login bug");
    expect(result).toEqual([
      { id: "ENG-42", event: "issue.assigned", summary: "Fix login bug" },
    ]);
  });

  it("parses single unassigned notification", () => {
    const result = parseNotificationMessage("Unassigned from issue ENG-42: Fix login bug");
    expect(result).toEqual([
      { id: "ENG-42", event: "issue.unassigned", summary: "Fix login bug" },
    ]);
  });

  it("parses single reassigned notification", () => {
    const result = parseNotificationMessage("Reassigned away from issue ENG-42: Fix login bug");
    expect(result).toEqual([
      { id: "ENG-42", event: "issue.reassigned", summary: "Fix login bug" },
    ]);
  });

  it("parses single mention notification", () => {
    const result = parseNotificationMessage(
      "Mentioned in comment on issue ENG-42: Fix login bug\n\n> Please review this",
    );
    expect(result).toEqual([
      { id: "ENG-42", event: "comment.mention", summary: "Fix login bug" },
    ]);
  });

  it("parses multi-notification message", () => {
    const message = [
      "You have 3 new Linear notifications:",
      "",
      "1. [Assigned] ENG-42: Fix login bug",
      '2. [Mentioned] ENG-43: "Can you review this?"',
      "3. [Reassigned] ENG-44: Update API docs",
      "",
      "Review and prioritize before starting work.",
    ].join("\n");

    const result = parseNotificationMessage(message);
    expect(result).toEqual([
      { id: "ENG-42", event: "issue.assigned", summary: "Fix login bug" },
      { id: "ENG-43", event: "comment.mention", summary: "Can you review this?" },
      { id: "ENG-44", event: "issue.reassigned", summary: "Update API docs" },
    ]);
  });

  it("returns empty for unrecognized message", () => {
    expect(parseNotificationMessage("Hello world")).toEqual([]);
  });

  it("handles unknown label in multi-notification", () => {
    const message = "You have 1 new Linear notifications:\n\n1. [Custom] ENG-1: Something";
    const result = parseNotificationMessage(message);
    expect(result).toEqual([
      { id: "ENG-1", event: "unknown.custom", summary: "Something" },
    ]);
  });
});

// --- readQueue / writeQueue ---

describe("readQueue", () => {
  it("returns empty queue when file does not exist", () => {
    expect(readQueue(QUEUE_PATH)).toEqual({ items: [] });
  });

  it("reads existing queue file", () => {
    const items = [makeItem()];
    seedQueue(items);
    const queue = readQueue(QUEUE_PATH);
    expect(queue.items).toHaveLength(1);
    expect(queue.items[0].id).toBe("ENG-1");
  });

  it("returns empty queue for corrupted JSON", () => {
    mkdirSync(join(TMP_DIR, "queue"), { recursive: true });
    writeFileSync(QUEUE_PATH, "not json {{{");
    expect(readQueue(QUEUE_PATH)).toEqual({ items: [] });
  });
});

describe("writeQueue", () => {
  it("creates parent directories and writes queue", () => {
    const queue: WorkQueue = { items: [makeItem()] };
    writeQueue(QUEUE_PATH, queue);
    const data = JSON.parse(readFileSync(QUEUE_PATH, "utf-8"));
    expect(data.items).toHaveLength(1);
    expect(data.items[0].id).toBe("ENG-1");
  });

  it("overwrites existing queue file", () => {
    seedQueue([makeItem({ id: "OLD-1", issueId: "OLD-1" })]);
    writeQueue(QUEUE_PATH, { items: [makeItem({ id: "NEW-1", issueId: "NEW-1" })] });
    const data = JSON.parse(readFileSync(QUEUE_PATH, "utf-8"));
    expect(data.items).toHaveLength(1);
    expect(data.items[0].id).toBe("NEW-1");
  });
});

// --- handleIntake ---

describe("handleIntake", () => {
  it("adds parsed items to empty queue", () => {
    const added = handleIntake("Assigned to issue ENG-42: Fix login bug", QUEUE_PATH);
    expect(added).toBe(1);
    const queue = readQueue(QUEUE_PATH);
    expect(queue.items).toHaveLength(1);
    expect(queue.items[0]).toMatchObject({
      id: "ENG-42",
      event: "issue.assigned",
      summary: "Fix login bug",
      status: "pending",
      priority: 1,
    });
  });

  it("deduplicates against existing pending items", () => {
    seedQueue([makeItem({ id: "ENG-42", issueId: "ENG-42", event: "issue.assigned" })]);
    const added = handleIntake("Assigned to issue ENG-42: Fix login bug", QUEUE_PATH);
    expect(added).toBe(0);
    expect(readQueue(QUEUE_PATH).items).toHaveLength(1);
  });

  it("deduplicates against existing in_progress items", () => {
    seedQueue([makeItem({ id: "ENG-42", issueId: "ENG-42", event: "issue.assigned", status: "in_progress" })]);
    const added = handleIntake("Assigned to issue ENG-42: Fix login bug", QUEUE_PATH);
    expect(added).toBe(0);
  });

  it("allows re-queue after item is done", () => {
    seedQueue([makeItem({
      id: "ENG-42",
      issueId: "ENG-42",
      event: "issue.assigned",
      status: "done",
      completedAt: new Date().toISOString(),
    })]);
    const added = handleIntake("Assigned to issue ENG-42: Fix login bug", QUEUE_PATH);
    expect(added).toBe(1);
    const queue = readQueue(QUEUE_PATH);
    // done item + new pending item
    expect(queue.items.filter((i) => i.id === "ENG-42")).toHaveLength(2);
  });

  it("allows same issue with different events", () => {
    seedQueue([makeItem({ id: "ENG-42", issueId: "ENG-42", event: "issue.assigned" })]);
    const msg = "Mentioned in comment on issue ENG-42: Fix login bug\n\n> thoughts?";
    const added = handleIntake(msg, QUEUE_PATH);
    expect(added).toBe(1);
    expect(readQueue(QUEUE_PATH).items).toHaveLength(2);
  });

  it("sorts by priority after intake", () => {
    const message = [
      "You have 3 new Linear notifications:",
      "",
      '1. [Mentioned] ENG-10: "hey"',
      "2. [Assigned] ENG-11: urgent fix",
      "3. [Reassigned] ENG-12: old task",
      "",
      "Review and prioritize before starting work.",
    ].join("\n");

    handleIntake(message, QUEUE_PATH);
    const queue = readQueue(QUEUE_PATH);
    expect(queue.items.map((i) => i.id)).toEqual(["ENG-11", "ENG-12", "ENG-10"]);
    expect(queue.items.map((i) => i.priority)).toEqual([1, 2, 3]);
  });

  it("returns 0 for unrecognized message", () => {
    expect(handleIntake("Hello world", QUEUE_PATH)).toBe(0);
  });

  it("deduplicates within the same batch", () => {
    const message = [
      "You have 2 new Linear notifications:",
      "",
      "1. [Assigned] ENG-42: Fix login bug",
      "2. [Assigned] ENG-42: Fix login bug",
      "",
      "Review and prioritize before starting work.",
    ].join("\n");

    const added = handleIntake(message, QUEUE_PATH);
    expect(added).toBe(1);
  });

  it("cleans up stale done items during intake", () => {
    const staleDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(); // 25h ago
    seedQueue([
      makeItem({ id: "OLD-1", issueId: "OLD-1", status: "done", completedAt: staleDate }),
      makeItem({ id: "ENG-99", issueId: "ENG-99", status: "pending" }),
    ]);

    handleIntake("Assigned to issue ENG-50: New task", QUEUE_PATH);
    const queue = readQueue(QUEUE_PATH);
    const ids = queue.items.map((i) => i.id);
    expect(ids).not.toContain("OLD-1");
    expect(ids).toContain("ENG-99");
    expect(ids).toContain("ENG-50");
  });
});

// --- handleRecovery ---

describe("handleRecovery", () => {
  it("returns 0 when queue file does not exist", () => {
    expect(handleRecovery(QUEUE_PATH)).toBe(0);
  });

  it("returns 0 when no items are in_progress", () => {
    seedQueue([makeItem({ status: "pending" }), makeItem({ id: "ENG-2", issueId: "ENG-2", status: "done" })]);
    expect(handleRecovery(QUEUE_PATH)).toBe(0);
  });

  it("resets in_progress items to pending", () => {
    const startedAt = new Date().toISOString();
    seedQueue([
      makeItem({ id: "ENG-1", issueId: "ENG-1", status: "in_progress", startedAt }),
      makeItem({ id: "ENG-2", issueId: "ENG-2", status: "pending" }),
      makeItem({ id: "ENG-3", issueId: "ENG-3", status: "in_progress", startedAt }),
    ]);

    const recovered = handleRecovery(QUEUE_PATH);
    expect(recovered).toBe(2);

    const queue = readQueue(QUEUE_PATH);
    for (const item of queue.items) {
      expect(item.status).not.toBe("in_progress");
      expect(item.startedAt).toBeNull();
    }
  });

  it("returns 0 for corrupted JSON", () => {
    mkdirSync(join(TMP_DIR, "queue"), { recursive: true });
    writeFileSync(QUEUE_PATH, "corrupted");
    expect(handleRecovery(QUEUE_PATH)).toBe(0);
  });

  it("returns 0 for empty items array", () => {
    seedQueue([]);
    expect(handleRecovery(QUEUE_PATH)).toBe(0);
  });
});

// --- cleanupDoneItems ---

describe("cleanupDoneItems", () => {
  it("removes done items older than maxAge", () => {
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const recent = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    const queue: WorkQueue = {
      items: [
        makeItem({ id: "OLD", issueId: "OLD", status: "done", completedAt: old }),
        makeItem({ id: "RECENT", issueId: "RECENT", status: "done", completedAt: recent }),
        makeItem({ id: "PENDING", issueId: "PENDING", status: "pending" }),
      ],
    };

    const purged = cleanupDoneItems(queue);
    expect(purged).toBe(1);
    expect(queue.items.map((i) => i.id)).toEqual(["RECENT", "PENDING"]);
  });

  it("removes done items with null completedAt", () => {
    const queue: WorkQueue = {
      items: [
        makeItem({ id: "BAD", issueId: "BAD", status: "done", completedAt: null }),
      ],
    };
    const purged = cleanupDoneItems(queue);
    expect(purged).toBe(1);
    expect(queue.items).toHaveLength(0);
  });

  it("keeps all items when none are done", () => {
    const queue: WorkQueue = {
      items: [
        makeItem({ id: "A", issueId: "A", status: "pending" }),
        makeItem({ id: "B", issueId: "B", status: "in_progress" }),
      ],
    };
    expect(cleanupDoneItems(queue)).toBe(0);
    expect(queue.items).toHaveLength(2);
  });

  it("respects custom maxAgeMs", () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const queue: WorkQueue = {
      items: [
        makeItem({ id: "A", issueId: "A", status: "done", completedAt: fiveMinAgo }),
      ],
    };
    // 1 minute max age — should purge
    expect(cleanupDoneItems(queue, 60 * 1000)).toBe(1);
  });
});
