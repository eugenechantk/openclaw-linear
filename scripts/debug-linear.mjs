#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

function usage() {
  console.error("Usage: node scripts/debug-linear.mjs <issue|event|runs> <id> [--sqlite path] [--debug-root path] [--limit n]");
  process.exit(2);
}

function option(name, fallback) {
  const idx = process.argv.indexOf(name);
  return idx === -1 ? fallback : process.argv[idx + 1] ?? fallback;
}

function safeSegment(value) {
  return value.replace(/[^a-zA-Z0-9._:-]/g, "_").slice(0, 180);
}

function readJsonl(path, limit) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-limit)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

const [kind, id] = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
if (!kind || !id || !["issue", "event", "runs"].includes(kind)) usage();

const openclawHome = process.env.OPENCLAW_HOME ?? join(homedir(), ".openclaw");
const sqlitePath = resolve(option("--sqlite", join(openclawHome, "queue", "linear.sqlite")));
const debugRoot = resolve(option("--debug-root", join(openclawHome, "state", "linear-debug")));
const limit = Math.max(1, Math.min(500, Number(option("--limit", "50")) || 50));

const output = {
  kind,
  id,
  sqlitePath,
  debugRoot,
  work: null,
  codexRuns: [],
  logs: [],
};

if (existsSync(sqlitePath)) {
  const db = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    if (kind === "issue" || kind === "runs") {
      output.work = db.prepare("SELECT * FROM issue_work WHERE issue_id = ?").get(id) ?? null;
      output.codexRuns = db
        .prepare("SELECT * FROM codex_runs WHERE issue_id = ? ORDER BY started_at DESC LIMIT ?")
        .all(id, limit);
    }
    if (kind === "event") {
      output.work = db.prepare("SELECT * FROM webhook_events WHERE delivery_id = ?").get(id) ?? null;
    }
  } finally {
    db.close();
  }
}

if (kind === "issue") {
  output.logs = readJsonl(join(debugRoot, "issues", `${safeSegment(id)}.jsonl`), limit);
} else if (kind === "event") {
  output.logs = readJsonl(join(debugRoot, "events", `${safeSegment(id)}.jsonl`), limit);
}

console.log(JSON.stringify(output, null, 2));

