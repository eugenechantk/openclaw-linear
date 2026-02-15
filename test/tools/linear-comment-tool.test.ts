import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/linear-api.js", () => ({
  graphql: vi.fn(),
  resolveIssueId: vi.fn(),
}));

const { graphql, resolveIssueId } = await import("../../src/linear-api.js");
const { createCommentTool } = await import("../../src/tools/linear-comment-tool.js");

const mockedGraphql = vi.mocked(graphql);
const mockedResolveIssueId = vi.mocked(resolveIssueId);

function parse(result: { content: { type: string; text?: string }[] }) {
  const text = result.content.find((c) => c.type === "text")?.text;
  return text ? JSON.parse(text) : undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("linear_comment tool", () => {
  it("has correct name", () => {
    const tool = createCommentTool();
    expect(tool.name).toBe("linear_comment");
  });

  describe("list", () => {
    it("returns comments for an issue", async () => {
      mockedResolveIssueId.mockResolvedValue("uuid-1");
      mockedGraphql.mockResolvedValue({
        issue: {
          comments: {
            nodes: [
              {
                id: "c1",
                body: "Hello",
                createdAt: "2025-01-01",
                updatedAt: "2025-01-01",
                user: { id: "u1", name: "Alice" },
                parent: null,
              },
            ],
          },
        },
      });

      const tool = createCommentTool();
      const result = await tool.execute("call-1", {
        action: "list",
        issueId: "ENG-42",
      });
      const data = parse(result);
      expect(data.comments).toHaveLength(1);
      expect(data.comments[0].body).toBe("Hello");
    });

    it("returns error without issueId", async () => {
      const tool = createCommentTool();
      const result = await tool.execute("call-1", { action: "list" });
      const data = parse(result);
      expect(data.error).toContain("issueId is required");
    });
  });

  describe("add", () => {
    it("creates a comment", async () => {
      mockedResolveIssueId.mockResolvedValue("uuid-1");
      mockedGraphql.mockResolvedValue({
        commentCreate: {
          success: true,
          comment: { id: "c-new", body: "My comment" },
        },
      });

      const tool = createCommentTool();
      const result = await tool.execute("call-1", {
        action: "add",
        issueId: "ENG-42",
        body: "My comment",
      });
      const data = parse(result);
      expect(data.success).toBe(true);
    });

    it("supports threading with parentCommentId", async () => {
      mockedResolveIssueId.mockResolvedValue("uuid-1");
      mockedGraphql.mockResolvedValue({
        commentCreate: {
          success: true,
          comment: { id: "c-reply", body: "Reply" },
        },
      });

      const tool = createCommentTool();
      await tool.execute("call-1", {
        action: "add",
        issueId: "ENG-42",
        body: "Reply",
        parentCommentId: "c1",
      });

      const call = mockedGraphql.mock.calls[0];
      const vars = call[1] as { input: { parentId?: string } };
      expect(vars.input.parentId).toBe("c1");
    });

    it("returns error without issueId", async () => {
      const tool = createCommentTool();
      const result = await tool.execute("call-1", {
        action: "add",
        body: "text",
      });
      const data = parse(result);
      expect(data.error).toContain("issueId is required");
    });

    it("returns error without body", async () => {
      const tool = createCommentTool();
      const result = await tool.execute("call-1", {
        action: "add",
        issueId: "ENG-42",
      });
      const data = parse(result);
      expect(data.error).toContain("body is required");
    });
  });

  describe("update", () => {
    it("updates a comment", async () => {
      mockedGraphql.mockResolvedValue({
        commentUpdate: {
          success: true,
          comment: { id: "c1", body: "Updated" },
        },
      });

      const tool = createCommentTool();
      const result = await tool.execute("call-1", {
        action: "update",
        commentId: "c1",
        body: "Updated",
      });
      const data = parse(result);
      expect(data.success).toBe(true);
    });

    it("returns error without commentId", async () => {
      const tool = createCommentTool();
      const result = await tool.execute("call-1", {
        action: "update",
        body: "text",
      });
      const data = parse(result);
      expect(data.error).toContain("commentId is required");
    });

    it("returns error without body", async () => {
      const tool = createCommentTool();
      const result = await tool.execute("call-1", {
        action: "update",
        commentId: "c1",
      });
      const data = parse(result);
      expect(data.error).toContain("body is required");
    });
  });

  it("catches and returns API errors", async () => {
    mockedResolveIssueId.mockRejectedValue(new Error("API down"));

    const tool = createCommentTool();
    const result = await tool.execute("call-1", {
      action: "list",
      issueId: "ENG-1",
    });
    const data = parse(result);
    expect(data.error).toContain("API down");
  });
});
