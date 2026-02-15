import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/linear-cli.js", () => ({
  execLinear: vi.fn(),
}));

const { execLinear } = await import("../src/linear-cli.js");
const { createCommentListTool } = await import("../src/linear-comment-list-tool.js");

const mockedExecLinear = vi.mocked(execLinear);

function parse(result: { content: { type: string; text?: string }[] }) {
  const text = result.content.find((c) => c.type === "text")?.text;
  return text ? JSON.parse(text) : undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("linear_comment_list tool", () => {
  it("has correct name and description", () => {
    const tool = createCommentListTool();
    expect(tool.name).toBe("linear_comment_list");
    expect(tool.description).toContain("comment");
  });

  it("returns parsed JSON comments on success", async () => {
    const comments = [
      { id: "c1", body: "First comment", user: { name: "Alice" } },
      { id: "c2", body: "Second comment", user: { name: "Bob" } },
    ];
    mockedExecLinear.mockResolvedValue({
      stdout: JSON.stringify(comments),
      stderr: "",
      exitCode: 0,
    });

    const tool = createCommentListTool();
    const result = await tool.execute("call-1", { issueId: "ENG-42" });
    const data = parse(result);

    expect(data).toEqual(comments);
    expect(mockedExecLinear).toHaveBeenCalledWith([
      "issue",
      "comment",
      "list",
      "ENG-42",
      "--json",
    ]);
  });

  it("returns error on non-zero exit code", async () => {
    mockedExecLinear.mockResolvedValue({
      stdout: "",
      stderr: "Not found",
      exitCode: 1,
    });

    const tool = createCommentListTool();
    const result = await tool.execute("call-1", { issueId: "NOPE-1" });
    const data = parse(result);

    expect(data.error).toContain("Failed to list comments");
  });

  it("returns error when CLI throws", async () => {
    mockedExecLinear.mockRejectedValue(new Error("ENOENT"));

    const tool = createCommentListTool();
    const result = await tool.execute("call-1", { issueId: "ENG-1" });
    const data = parse(result);

    expect(data.error).toContain("linear CLI error");
  });
});
