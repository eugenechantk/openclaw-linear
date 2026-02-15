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
  appendFileSync,
} from "node:fs";
import { dirname } from "node:path";

export interface QueueItem {
  id: string;
  issueId: string;
  event: string;
  summary: string;
  priority: number;
  addedAt: string;
}

export const QUEUE_EVENT: Record<string, string> = {
  "issue.assigned": "ticket",
  "issue.reassigned": "ticket",
  "comment.mention": "mention",
};

export interface EnqueueEntry {
  id: string;
  event: string;
  summary: string;
  issuePriority: number;
}

/** Map Linear priority (0=none) so no-priority sorts last. */
function mapPriority(linearPriority: number): number {
  return linearPriority === 0 ? 5 : linearPriority;
}

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

// --- Mutex ---

export class Mutex {
  private _lock: Promise<void> = Promise.resolve();

  async acquire(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((r) => {
      release = r;
    });
    const prev = this._lock;
    this._lock = next;
    await prev;
    return release;
  }
}

// --- InboxQueue ---

function readJsonl(path: string): QueueItem[] {
  if (!existsSync(path)) return [];
  try {
    const content = readFileSync(path, "utf-8");
    const items: QueueItem[] = [];
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        items.push(JSON.parse(trimmed) as QueueItem);
      } catch {
        // skip malformed lines
      }
    }
    return items;
  } catch {
    return [];
  }
}

function writeJsonl(path: string, items: QueueItem[]): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const tmpPath = `${path}.tmp.${process.pid}.${Date.now()}`;
  const content = items.map((item) => JSON.stringify(item)).join("\n") + (items.length ? "\n" : "");
  try {
    const fd = openSync(tmpPath, "w");
    try {
      writeSync(fd, content, 0, "utf-8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmpPath, path);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* ignore cleanup errors */
    }
    throw err;
  }
}

function appendJsonl(path: string, items: QueueItem[]): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const content = items.map((item) => JSON.stringify(item)).join("\n") + "\n";
  appendFileSync(path, content, "utf-8");
}

export class InboxQueue {
  private readonly mutex = new Mutex();

  constructor(private readonly path: string) {}

  /** Dedup and append entries to the queue. Returns count added. */
  async enqueue(entries: EnqueueEntry[]): Promise<number> {
    if (entries.length === 0) return 0;

    const release = await this.mutex.acquire();
    try {
      const existing = readJsonl(this.path);

      // Handle unassign removals — remove existing ticket items for unassigned issues
      const unassignIds = new Set(
        entries
          .filter((e) => e.event === "issue.unassigned")
          .map((e) => e.id),
      );

      let filtered = existing;
      if (unassignIds.size > 0) {
        filtered = existing.filter(
          (item) => !(unassignIds.has(item.issueId) && item.event === "ticket"),
        );
        if (filtered.length !== existing.length) {
          writeJsonl(this.path, filtered);
        }
      }

      // Build dedup set from remaining items using mapped queue events
      const existingKeys = new Set(
        filtered.map((item) => `${item.issueId}:${item.event}`),
      );

      const newItems: QueueItem[] = [];
      const now = new Date().toISOString();

      for (const entry of entries) {
        const queueEvent = QUEUE_EVENT[entry.event];
        if (!queueEvent) continue; // skip unmapped events (e.g. issue.unassigned)

        const dedupKey = `${entry.id}:${queueEvent}`;
        if (existingKeys.has(dedupKey)) continue;

        newItems.push({
          id: entry.id,
          issueId: entry.id,
          event: queueEvent,
          summary: entry.summary,
          priority: mapPriority(entry.issuePriority),
          addedAt: now,
        });
        existingKeys.add(dedupKey);
      }

      if (newItems.length > 0) {
        appendJsonl(this.path, newItems);
      }

      return newItems.length;
    } finally {
      release();
    }
  }

  /** Return all items sorted by priority (lowest number first). Non-destructive. */
  async peek(): Promise<QueueItem[]> {
    const release = await this.mutex.acquire();
    try {
      const items = readJsonl(this.path);
      return items.sort((a, b) => a.priority - b.priority || a.addedAt.localeCompare(b.addedAt));
    } finally {
      release();
    }
  }

  /** Remove and return the highest-priority item, or null if empty. */
  async pop(): Promise<QueueItem | null> {
    const release = await this.mutex.acquire();
    try {
      const items = readJsonl(this.path);
      if (items.length === 0) return null;

      items.sort((a, b) => a.priority - b.priority || a.addedAt.localeCompare(b.addedAt));
      const [popped, ...rest] = items;
      writeJsonl(this.path, rest);
      return popped;
    } finally {
      release();
    }
  }

  /** Remove and return all items sorted by priority. */
  async drain(): Promise<QueueItem[]> {
    const release = await this.mutex.acquire();
    try {
      const items = readJsonl(this.path);
      if (items.length === 0) return [];

      items.sort((a, b) => a.priority - b.priority || a.addedAt.localeCompare(b.addedAt));
      writeJsonl(this.path, []);
      return items;
    } finally {
      release();
    }
  }
}
