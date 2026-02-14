import { describe, it, expect, vi } from "vitest";
import { createEventRouter } from "./event-router.js";
import type { LinearWebhookPayload } from "./webhook-handler.js";
import type { EventRouterConfig } from "./event-router.js";

function makeConfig(
  agentMapping: Record<string, string> = {
    "user-1": "agent-1",
    "user-2": "agent-2",
  },
  overrides?: Partial<EventRouterConfig>,
): EventRouterConfig {
  return {
    agentMapping,
    logger: { info: vi.fn(), error: vi.fn() },
    ...overrides,
  };
}

describe("event-router", () => {
  describe("assignment changes", () => {
    it("routes new assignment as wake event", () => {
      const config = makeConfig();
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "Issue",
        action: "update",
        data: {
          id: "issue-123",
          changes: { assigneeId: { to: "user-1" } },
        },
        createdAt: new Date().toISOString(),
      };

      const actions = route(event);
      expect(actions).toEqual([
        {
          type: "wake",
          agentId: "agent-1",
          event: "issue.assigned",
          detail: "Assigned to issue issue-123",
          issueId: "issue-123",
          issueLabel: "issue-123",
          linearUserId: "user-1",
        },
      ]);
    });

    it("includes issue identifier and title in detail when available", () => {
      const config = makeConfig();
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "Issue",
        action: "update",
        data: {
          id: "issue-123",
          identifier: "ENG-42",
          title: "Fix login bug",
          changes: { assigneeId: { to: "user-1" } },
        },
        createdAt: new Date().toISOString(),
      };

      const actions = route(event);
      expect(actions[0].detail).toBe("Assigned to issue ENG-42: Fix login bug");
      expect(actions[0].issueLabel).toBe("ENG-42: Fix login bug");
    });

    it("routes unassignment as notify event", () => {
      const config = makeConfig();
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "Issue",
        action: "update",
        data: {
          id: "issue-456",
          changes: { assigneeId: { from: "user-2" } },
        },
        createdAt: new Date().toISOString(),
      };

      const actions = route(event);
      expect(actions).toEqual([
        {
          type: "notify",
          agentId: "agent-2",
          event: "issue.unassigned",
          detail: "Unassigned from issue issue-456",
          issueId: "issue-456",
          issueLabel: "issue-456",
          linearUserId: "user-2",
        },
      ]);
    });

    it("notifies old assignee on reassignment", () => {
      const config = makeConfig();
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "Issue",
        action: "update",
        data: {
          id: "issue-789",
          changes: { assigneeId: { from: "user-2", to: "user-1" } },
        },
        createdAt: new Date().toISOString(),
      };

      const actions = route(event);
      expect(actions).toHaveLength(2);

      // New assignee gets wake
      expect(actions[0]).toMatchObject({
        type: "wake",
        agentId: "agent-1",
        event: "issue.assigned",
        linearUserId: "user-1",
      });

      // Old assignee gets notify
      expect(actions[1]).toMatchObject({
        type: "notify",
        agentId: "agent-2",
        event: "issue.reassigned",
        linearUserId: "user-2",
      });
    });
  });

  describe("comment mentions", () => {
    it("routes @mention in comment as wake event", () => {
      const config = makeConfig();
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "Comment",
        action: "create",
        data: {
          body: "Hey @user-1 can you look at this?",
          issue: { id: "issue-789" },
        },
        createdAt: new Date().toISOString(),
      };

      const actions = route(event);
      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({
        type: "wake",
        agentId: "agent-1",
        event: "comment.mention",
        issueId: "issue-789",
        linearUserId: "user-1",
      });
      expect(actions[0].detail).toContain("Mentioned in comment on issue");
      expect(actions[0].detail).toContain("Hey @user-1 can you look at this?");
    });

    it("routes multiple mentions to multiple agents", () => {
      const config = makeConfig();
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "Comment",
        action: "update",
        data: {
          body: "cc @user-1 @user-2",
          issue: { id: "issue-100" },
        },
        createdAt: new Date().toISOString(),
      };

      const actions = route(event);
      expect(actions).toHaveLength(2);
      expect(actions[0].agentId).toBe("agent-1");
      expect(actions[1].agentId).toBe("agent-2");
    });

    it("extracts mentions from ProseMirror bodyData when available", () => {
      const config = makeConfig();
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "Comment",
        action: "create",
        data: {
          body: "Hey John can you look at this?",
          bodyData: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [
                  { type: "text", text: "Hey " },
                  {
                    type: "mention",
                    attrs: { id: "user-1", label: "John" },
                  },
                  { type: "text", text: " can you look at this?" },
                ],
              },
            ],
          },
          issue: { id: "issue-300" },
        },
        createdAt: new Date().toISOString(),
      };

      const actions = route(event);
      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({
        agentId: "agent-1",
        linearUserId: "user-1",
      });
    });

    it("deduplicates mentions from ProseMirror bodyData", () => {
      const config = makeConfig();
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "Comment",
        action: "create",
        data: {
          body: "Hey @user-1 and @user-1 again",
          bodyData: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [
                  {
                    type: "mention",
                    attrs: { id: "user-1", label: "John" },
                  },
                  { type: "text", text: " and " },
                  {
                    type: "mention",
                    attrs: { id: "user-1", label: "John" },
                  },
                ],
              },
            ],
          },
          issue: { id: "issue-400" },
        },
        createdAt: new Date().toISOString(),
      };

      const actions = route(event);
      expect(actions).toHaveLength(1);
    });

    it("falls back to regex when bodyData has no mentions", () => {
      const config = makeConfig();
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "Comment",
        action: "create",
        data: {
          body: "Hey @user-1 check this",
          bodyData: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "Hey @user-1 check this" }],
              },
            ],
          },
          issue: { id: "issue-500" },
        },
        createdAt: new Date().toISOString(),
      };

      const actions = route(event);
      expect(actions).toHaveLength(1);
      expect(actions[0].agentId).toBe("agent-1");
    });
  });

  describe("unmapped users", () => {
    it("logs unmapped user on assignment and returns no actions", () => {
      const config = makeConfig({});
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "Issue",
        action: "update",
        data: {
          id: "issue-999",
          changes: { assigneeId: { to: "unknown-user" } },
        },
        createdAt: new Date().toISOString(),
      };

      const actions = route(event);
      expect(actions).toEqual([]);
      expect(config.logger.info).toHaveBeenCalledWith(
        "Unmapped Linear user unknown-user assigned to issue-999",
      );
    });

    it("logs unmapped user on comment mention and returns no actions", () => {
      const config = makeConfig({});
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "Comment",
        action: "create",
        data: {
          body: "Hey @unknown-user check this",
          issue: { id: "issue-500" },
        },
        createdAt: new Date().toISOString(),
      };

      const actions = route(event);
      expect(actions).toEqual([]);
      expect(config.logger.info).toHaveBeenCalledWith(
        "Unmapped Linear user unknown-user mentioned in comment on issue-500",
      );
    });
  });

  describe("unrelated events", () => {
    it("returns empty for non-issue non-comment events", () => {
      const config = makeConfig();
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "Project",
        action: "create",
        data: { id: "proj-1" },
        createdAt: new Date().toISOString(),
      };

      expect(route(event)).toEqual([]);
    });

    it("returns empty for issue create (not update)", () => {
      const config = makeConfig();
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "Issue",
        action: "create",
        data: { id: "issue-1" },
        createdAt: new Date().toISOString(),
      };

      expect(route(event)).toEqual([]);
    });
  });

  describe("event filtering", () => {
    it("filters out events not in eventFilter", () => {
      const config = makeConfig(
        { "user-1": "agent-1" },
        { eventFilter: ["Comment"] },
      );
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "Issue",
        action: "update",
        data: {
          id: "issue-1",
          changes: { assigneeId: { to: "user-1" } },
        },
        createdAt: new Date().toISOString(),
      };

      expect(route(event)).toEqual([]);
    });

    it("allows events matching eventFilter", () => {
      const config = makeConfig(
        { "user-1": "agent-1" },
        { eventFilter: ["Issue"] },
      );
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "Issue",
        action: "update",
        data: {
          id: "issue-1",
          changes: { assigneeId: { to: "user-1" } },
        },
        createdAt: new Date().toISOString(),
      };

      expect(route(event)).toHaveLength(1);
    });
  });

  describe("team filtering", () => {
    it("filters out events from non-matching teams by teamId", () => {
      const config = makeConfig(
        { "user-1": "agent-1" },
        { teamIds: ["team-eng"] },
      );
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "Issue",
        action: "update",
        data: {
          id: "issue-1",
          teamId: "team-ops",
          changes: { assigneeId: { to: "user-1" } },
        },
        createdAt: new Date().toISOString(),
      };

      expect(route(event)).toEqual([]);
    });

    it("allows events from matching teams by team key", () => {
      const config = makeConfig(
        { "user-1": "agent-1" },
        { teamIds: ["ENG"] },
      );
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "Issue",
        action: "update",
        data: {
          id: "issue-1",
          team: { key: "ENG" },
          changes: { assigneeId: { to: "user-1" } },
        },
        createdAt: new Date().toISOString(),
      };

      expect(route(event)).toHaveLength(1);
    });

    it("allows events when no team info is present (cannot filter)", () => {
      const config = makeConfig(
        { "user-1": "agent-1" },
        { teamIds: ["ENG"] },
      );
      const route = createEventRouter(config);

      const event: LinearWebhookPayload = {
        type: "Issue",
        action: "update",
        data: {
          id: "issue-1",
          changes: { assigneeId: { to: "user-1" } },
        },
        createdAt: new Date().toISOString(),
      };

      // No team info on event → can't filter → allow through
      expect(route(event)).toHaveLength(1);
    });
  });
});
