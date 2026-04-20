import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type LinearDebugLogEntry = {
  at?: string;
  type: string;
  issueId?: string | null;
  sessionKey?: string | null;
  deliveryId?: string | null;
  [key: string]: unknown;
};

export type DebugLogScope = "issue" | "session" | "event";

type Logger = {
  error: (message: string) => void;
};

function nowIso(): string {
  return new Date().toISOString();
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._:-]/g, "_").slice(0, 180);
}

function pathFor(rootPath: string, scope: DebugLogScope, id: string): string {
  const dir = scope === "issue" ? "issues" : scope === "session" ? "sessions" : "events";
  return join(rootPath, dir, `${safeSegment(id)}.jsonl`);
}

export function resolveLinearDebugRoot(configuredPath?: unknown): string {
  if (typeof configuredPath === "string" && configuredPath.trim()) {
    return configuredPath.startsWith("/")
      ? configuredPath
      : join(process.env.OPENCLAW_HOME ?? join(homedir(), ".openclaw"), configuredPath);
  }

  return join(process.env.OPENCLAW_HOME ?? join(homedir(), ".openclaw"), "state", "linear-debug");
}

export function readDebugLogEntries(
  rootPath: string,
  scope: DebugLogScope,
  id: string,
  limit = 50,
): LinearDebugLogEntry[] {
  const filePath = pathFor(rootPath, scope, id);
  if (!existsSync(filePath)) return [];
  const lines = readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean);
  const selected = lines.slice(-Math.max(1, Math.min(500, Math.floor(limit))));
  return selected.flatMap((line) => {
    try {
      const parsed = JSON.parse(line) as unknown;
      return parsed && typeof parsed === "object"
        ? [parsed as LinearDebugLogEntry]
        : [];
    } catch {
      return [];
    }
  });
}

export class LinearDebugLogger {
  constructor(
    private readonly rootPath: string,
    private readonly logger?: Logger,
  ) {}

  append(entry: LinearDebugLogEntry): void {
    const normalized = {
      at: entry.at ?? nowIso(),
      ...entry,
    };

    const targets = new Set<string>();
    if (entry.issueId) targets.add(pathFor(this.rootPath, "issue", entry.issueId));
    if (entry.sessionKey) targets.add(pathFor(this.rootPath, "session", entry.sessionKey));
    if (entry.deliveryId) targets.add(pathFor(this.rootPath, "event", entry.deliveryId));
    if (targets.size === 0) targets.add(join(this.rootPath, "general.jsonl"));

    const line = `${JSON.stringify(normalized)}\n`;
    for (const filePath of targets) {
      try {
        mkdirSync(dirname(filePath), { recursive: true });
        appendFileSync(filePath, line, "utf8");
      } catch (err) {
        this.logger?.error(`[linear] Failed to append debug log: ${(err as Error).message}`);
      }
    }
  }
}
