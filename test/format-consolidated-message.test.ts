import { describe, it, expect } from "vitest";
import { formatConsolidatedMessage } from "../src/index.js";
import type { RouterAction } from "../src/event-router.js";

function makeAction(overrides: Partial<RouterAction> = {}): RouterAction {
  return {
    type: "wake",
    agentId: "agent-1",
    event: "issue.assigned",
    detail: "Assigned to issue ENG-42: Fix login bug",
    issueId: "issue-42",
    issueLabel: "ENG-42: Fix login bug",
    identifier: "ENG-42",
    issuePriority: 0,
    linearUserId: "user-1",
    ...overrides,
  };
}

describe("formatConsolidatedMessage", () => {
  it("returns raw detail for a single action", () => {
    const result = formatConsolidatedMessage([makeAction()]);
    expect(result).toBe("Assigned to issue ENG-42: Fix login bug");
  });

  it("formats multiple assigned actions as a numbered list", () => {
    const actions = [
      makeAction({ detail: "Assigned to issue ENG-42: Fix login bug", issueId: "issue-42", issueLabel: "ENG-42: Fix login bug" }),
      makeAction({ detail: "Assigned to issue ENG-43: Update API docs", issueId: "issue-43", issueLabel: "ENG-43: Update API docs" }),
    ];

    const result = formatConsolidatedMessage(actions);

    expect(result).toContain("You have 2 new Linear notifications:");
    expect(result).toContain("1. [Assigned] ENG-42: Fix login bug");
    expect(result).toContain("2. [Assigned] ENG-43: Update API docs");
    expect(result).toContain("Review and prioritize before starting work.");
  });

  it("formats comment mention with quoted body", () => {
    const actions = [
      makeAction({ detail: "Assigned to issue ENG-42: Fix login bug" }),
      makeAction({
        event: "comment.mention",
        detail: "Mentioned in comment on issue ENG-40: Auth flow\n\n> Can you review the auth flow?",
        issueId: "issue-40",
        issueLabel: "ENG-40: Auth flow",
      }),
    ];

    const result = formatConsolidatedMessage(actions);

    expect(result).toContain('1. [Assigned] ENG-42: Fix login bug');
    expect(result).toContain('2. [Mentioned] ENG-40: Auth flow: "Can you review the auth flow?"');
  });

  it("handles mixed event types", () => {
    const actions = [
      makeAction({ event: "issue.assigned", detail: "Assigned to issue ENG-42: Fix login bug", issueLabel: "ENG-42: Fix login bug" }),
      makeAction({ event: "issue.unassigned", detail: "Unassigned from issue ENG-50: Old task", issueLabel: "ENG-50: Old task" }),
      makeAction({ event: "issue.reassigned", detail: "Reassigned away from issue ENG-51: Moved task", issueLabel: "ENG-51: Moved task" }),
    ];

    const result = formatConsolidatedMessage(actions);

    expect(result).toContain("You have 3 new Linear notifications:");
    expect(result).toContain("1. [Assigned] ENG-42: Fix login bug");
    expect(result).toContain("2. [Unassigned] ENG-50: Old task");
    expect(result).toContain("3. [Reassigned] ENG-51: Moved task");
  });

  it("handles actions without identifier (uses issue id)", () => {
    const actions = [
      makeAction({ detail: "Assigned to issue some-uuid", issueLabel: "some-uuid" }),
      makeAction({ detail: "Assigned to issue another-uuid", issueLabel: "another-uuid" }),
    ];

    const result = formatConsolidatedMessage(actions);

    expect(result).toContain("1. [Assigned] some-uuid");
    expect(result).toContain("2. [Assigned] another-uuid");
  });

  it("falls back to raw event name for unknown event types", () => {
    const actions = [
      makeAction({ event: "issue.assigned", detail: "Assigned to issue ENG-1: A", issueLabel: "ENG-1: A" }),
      makeAction({ event: "custom.event" as string, detail: "Something happened", issueLabel: "ENG-2: B" }),
    ];

    const result = formatConsolidatedMessage(actions);

    expect(result).toContain("1. [Assigned] ENG-1: A");
    expect(result).toContain("2. [custom.event] ENG-2: B");
  });

  it("handles comment mention without quote body gracefully", () => {
    const actions = [
      makeAction({
        event: "comment.mention",
        detail: "Mentioned in comment on issue ENG-40: Auth flow",
        issueId: "issue-40",
        issueLabel: "ENG-40: Auth flow",
      }),
      makeAction({ detail: "Assigned to issue ENG-42: Fix login bug" }),
    ];

    const result = formatConsolidatedMessage(actions);

    // Without the "\n\n> " separator, falls back to issueLabel
    expect(result).toContain("1. [Mentioned] ENG-40: Auth flow");
    expect(result).toContain("2. [Assigned] ENG-42: Fix login bug");
  });
});
