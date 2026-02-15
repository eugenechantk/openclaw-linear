import {
  readFileSync,
  existsSync,
  mkdirSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  unlinkSync,
  renameSync,
} from "node:fs";
import { dirname } from "node:path";

export interface QueueItem {
  id: string;
  issueId: string;
  event: string;
  summary: string;
  status: "pending" | "in_progress" | "done";
  priority: number;
  addedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface WorkQueue {
  items: QueueItem[];
}

const EVENT_PRIORITY: Record<string, number> = {
  "issue.assigned": 1,
  "issue.reassigned": 2,
  "comment.mention": 3,
  "issue.unassigned": 4,
};

// --- Parsing ---

function parseNotificationLine(
  line: string,
): { id: string; event: string; summary: string } | null {
  // Multi-notification with quoted comment: "N. [Mentioned] TEAM-123: "comment text""
  const mentionMatch = line.match(
    /^\d+\.\s+\[Mentioned\]\s+([A-Z]+-\d+):\s*"(.+)"$/,
  );
  if (mentionMatch) {
    return {
      id: mentionMatch[1],
      event: "comment.mention",
      summary: mentionMatch[2].trim(),
    };
  }

  // Multi-notification format: "N. [Label] TEAM-123: summary"
  const multiMatch = line.match(
    /^\d+\.\s+\[(\w+(?:\s+\w+)?)\]\s+([A-Z]+-\d+):\s*(.+)$/,
  );
  if (multiMatch) {
    const [, label, id, summary] = multiMatch;
    return { id, event: labelToEvent(label), summary: summary.trim() };
  }

  // Single: "Assigned to issue TEAM-123: summary"
  const assignedMatch = line.match(
    /^Assigned to issue ([A-Z]+-\d+):\s*(.+)$/,
  );
  if (assignedMatch) {
    return {
      id: assignedMatch[1],
      event: "issue.assigned",
      summary: assignedMatch[2].trim(),
    };
  }

  // Single: "Unassigned from issue TEAM-123: summary"
  const unassignedMatch = line.match(
    /^Unassigned from issue ([A-Z]+-\d+):\s*(.+)$/,
  );
  if (unassignedMatch) {
    return {
      id: unassignedMatch[1],
      event: "issue.unassigned",
      summary: unassignedMatch[2].trim(),
    };
  }

  // Single: "Reassigned away from issue TEAM-123: summary"
  const reassignedMatch = line.match(
    /^Reassigned away from issue ([A-Z]+-\d+):\s*(.+)$/,
  );
  if (reassignedMatch) {
    return {
      id: reassignedMatch[1],
      event: "issue.reassigned",
      summary: reassignedMatch[2].trim(),
    };
  }

  // Single: "Mentioned in comment on issue TEAM-123: summary\n\n> body"
  const mentionedMatch = line.match(
    /^Mentioned in comment on issue ([A-Z]+-\d+):\s*(.+?)(?:\n|$)/,
  );
  if (mentionedMatch) {
    return {
      id: mentionedMatch[1],
      event: "comment.mention",
      summary: mentionedMatch[2].trim(),
    };
  }

  return null;
}

function labelToEvent(label: string): string {
  const map: Record<string, string> = {
    Assigned: "issue.assigned",
    Unassigned: "issue.unassigned",
    Reassigned: "issue.reassigned",
    Mentioned: "comment.mention",
  };
  return map[label] ?? `unknown.${label.toLowerCase()}`;
}

export function parseNotificationMessage(
  message: string,
): Array<{ id: string; event: string; summary: string }> {
  const results: Array<{ id: string; event: string; summary: string }> = [];

  if (message.startsWith("You have ")) {
    for (const line of message.split("\n").filter((l) => l.trim())) {
      const parsed = parseNotificationLine(line.trim());
      if (parsed) results.push(parsed);
    }
  } else {
    const parsed = parseNotificationLine(message.trim());
    if (parsed) results.push(parsed);
  }

  return results;
}

// --- File I/O ---

export function readQueue(queuePath: string): WorkQueue {
  if (!existsSync(queuePath)) return { items: [] };
  try {
    return JSON.parse(readFileSync(queuePath, "utf-8")) as WorkQueue;
  } catch {
    return { items: [] };
  }
}

export function writeQueue(queuePath: string, queue: WorkQueue): void {
  const dir = dirname(queuePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const tmpPath = `${queuePath}.tmp.${process.pid}.${Date.now()}`;
  const content = JSON.stringify(queue, null, 2) + "\n";
  try {
    const fd = openSync(tmpPath, "w");
    try {
      writeSync(fd, content, 0, "utf-8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmpPath, queuePath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* ignore cleanup errors */
    }
    throw err;
  }
}

// --- Intake ---

/**
 * Parse a consolidated notification message and append new items to the work queue.
 * Deduplicates against non-done items only (completed items can be re-queued).
 * Returns the number of new items added.
 */
export function handleIntake(message: string, queuePath: string): number {
  const parsed = parseNotificationMessage(message);
  if (parsed.length === 0) return 0;

  const queue = readQueue(queuePath);

  // Only dedup against non-done items so re-assignments after completion work
  const existingKeys = new Set(
    queue.items
      .filter((item) => item.status !== "done")
      .map((item) => `${item.issueId ?? item.id}:${item.event}`),
  );

  let added = 0;
  const now = new Date().toISOString();

  for (const entry of parsed) {
    const dedupKey = `${entry.id}:${entry.event}`;
    if (existingKeys.has(dedupKey)) continue;

    queue.items.push({
      id: entry.id,
      issueId: entry.id,
      event: entry.event,
      summary: entry.summary,
      status: "pending",
      priority: EVENT_PRIORITY[entry.event] ?? 5,
      addedAt: now,
      startedAt: null,
      completedAt: null,
    });
    existingKeys.add(dedupKey);
    added++;
  }

  if (added > 0) {
    cleanupDoneItems(queue);
    queue.items.sort((a, b) => a.priority - b.priority);
    writeQueue(queuePath, queue);
  }

  return added;
}

// --- Recovery ---

/**
 * Reset stale in_progress items to pending.
 * Called on gateway startup to recover from crashes/restarts.
 */
export function handleRecovery(queuePath: string): number {
  if (!existsSync(queuePath)) return 0;

  let queue: WorkQueue;
  try {
    queue = JSON.parse(readFileSync(queuePath, "utf-8")) as WorkQueue;
  } catch {
    return 0;
  }

  if (!Array.isArray(queue.items) || queue.items.length === 0) return 0;

  let recovered = 0;
  for (const item of queue.items) {
    if (item.status === "in_progress") {
      item.status = "pending";
      item.startedAt = null;
      recovered++;
    }
  }

  if (recovered > 0) {
    writeQueue(queuePath, queue);
  }

  return recovered;
}

// --- Cleanup ---

const DONE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Remove done items older than maxAgeMs from the queue.
 * Mutates the queue in place. Returns number of items purged.
 */
export function cleanupDoneItems(
  queue: WorkQueue,
  maxAgeMs: number = DONE_MAX_AGE_MS,
): number {
  const cutoff = Date.now() - maxAgeMs;
  const before = queue.items.length;
  queue.items = queue.items.filter((item) => {
    if (item.status !== "done") return true;
    const completedAt = item.completedAt
      ? new Date(item.completedAt).getTime()
      : 0;
    return completedAt > cutoff;
  });
  return before - queue.items.length;
}
