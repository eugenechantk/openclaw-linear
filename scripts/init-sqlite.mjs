#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(scriptDir, "..");
const schemaPath = resolve(pluginRoot, "schema.sql");
const openclawHome = process.env.OPENCLAW_HOME ?? resolve(homedir(), ".openclaw");
const dbPath = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(openclawHome, "queue", "linear.sqlite");

if (!existsSync(schemaPath)) {
  console.error(`Schema file not found: ${schemaPath}`);
  process.exit(1);
}

mkdirSync(dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);
try {
  db.exec(readFileSync(schemaPath, "utf8"));
} finally {
  db.close();
}

console.log(`Initialized OpenClaw Linear SQLite schema at ${dbPath}`);
