import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { IssueWorkStore } from "../../src/issue-work-store.js";
import type { EnqueueEntry } from "../../src/work-queue.js";

vi.mock("openclaw/plugin-sdk/agent-runtime", () => ({
  jsonResult: (data: unknown) => ({
    content: [{ type: "text", text: JSON.stringify(data) }],
  }),
  stringEnum: (values: readonly string[]) => ({ enum: values }),
}));

import { createIssueWorkTool } from "../../src/tools/issue-work-tool.js";

const TMP_DIR = join(import.meta.dirname ?? __dirname, "../../.test-tmp-issue-work-tool");
const DB_PATH = join(TMP_DIR, "issue-work.sqlite");

function parse(result: { content: { type: string; text?: string }[] }) {
  const text = result.content.find((c) => c.type === "text")?.text;
  return text ? JSON.parse(text) : undefined;
}

function entry(id: string, issueId: string, event: string): EnqueueEntry {
  return {
    id,
    issueId,
    event,
    summary: `${issueId}: Test issue`,
    issuePriority: 3,
  };
}

beforeEach(() => {
  mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

describe("linear_issue_work tool", () => {
  it("views issue work and Codex runs", async () => {
    const store = new IssueWorkStore(DB_PATH);
    await store.enqueue([entry("EUG-55", "EUG-55", "issue.assigned")]);

    const tool = createIssueWorkTool(store);
    const result = await tool.execute("call-1", { action: "view", issueId: "EUG-55" });
    const data = parse(result);

    expect(data.issueId).toBe("EUG-55");
    expect(data.work).toMatchObject({ issueId: "EUG-55", status: "pending" });
    expect(data.codexRuns).toEqual([]);
  });

  it("delegates completion to the dispatcher", async () => {
    const store = new IssueWorkStore(DB_PATH);
    const completeIssueWork = vi.fn(async () => ({
      type: "completed",
      issueId: "EUG-55",
      transition: "in_review",
    }));

    const tool = createIssueWorkTool(store, { completeIssueWork });
    const result = await tool.execute("call-1", { action: "complete", issueId: "EUG-55" });
    const data = parse(result);

    expect(completeIssueWork).toHaveBeenCalledWith("EUG-55");
    expect(data.completed).toBe(true);
    expect(data.decision).toMatchObject({ transition: "in_review" });
  });

  it("recovers expired leases", async () => {
    const store = new IssueWorkStore(DB_PATH);
    await store.enqueue([entry("EUG-55", "EUG-55", "issue.assigned")]);
    await store.claim("EUG-55");
    const db = new DatabaseSync(DB_PATH);
    db.prepare(`
      UPDATE issue_work
      SET lease_expires_at = '2026-04-19T00:00:00.000Z'
      WHERE issue_id = 'EUG-55'
    `).run();
    db.close();

    const tool = createIssueWorkTool(store);
    const result = await tool.execute("call-1", { action: "recover", includeUnleased: true });
    const data = parse(result);

    expect(data.recovered).toBe(1);
    expect(store.getWork("EUG-55")).toMatchObject({
      status: "pending",
      workStatus: "pending",
    });
  });
});
