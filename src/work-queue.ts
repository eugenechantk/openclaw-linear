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
  "issue.state_readded": "ticket",
  "comment.mention": "mention",
};

const REMOVAL_EVENTS = new Set([
  "issue.unassigned",
  "issue.reassigned",
  "issue.removed",
  "issue.state_removed",
]);

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

      // Handle removal events — remove existing ticket items for affected issues
      const removalIds = new Set(
        entries
          .filter((e) => REMOVAL_EVENTS.has(e.event))
          .map((e) => e.id),
      );

      // Handle priority updates — update matching items' priority in-place
      const priorityUpdates = new Map(
        entries
          .filter((e) => e.event === "issue.priority_changed")
          .map((e) => [e.id, mapPriority(e.issuePriority)]),
      );

      let filtered = existing;
      let dirty = false;

      if (removalIds.size > 0) {
        filtered = existing.filter(
          (item) => !(removalIds.has(item.issueId) && item.event === "ticket"),
        );
        if (filtered.length !== existing.length) dirty = true;
      }

      if (priorityUpdates.size > 0) {
        for (const item of filtered) {
          const newPriority = priorityUpdates.get(item.issueId);
          if (newPriority !== undefined && item.priority !== newPriority) {
            item.priority = newPriority;
            dirty = true;
          }
        }
      }

      if (dirty) {
        writeJsonl(this.path, filtered);
      }

      // Build dedup set from remaining items using mapped queue events
      const existingKeys = new Set(
        filtered.map((item) => `${item.issueId}:${item.event}`),
      );

      const newItems: QueueItem[] = [];
      const now = new Date().toISOString();

      for (const entry of entries) {
        const queueEvent = QUEUE_EVENT[entry.event];
        if (!queueEvent) continue; // skip unmapped events

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
