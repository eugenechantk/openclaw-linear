import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./linear-cli.js", () => ({
  execLinear: vi.fn(),
  withTempFile: vi.fn(),
}));

const { execLinear, withTempFile } = await import("./linear-cli.js");
const { createCommentAddTool } = await import("./linear-comment-add-tool.js");

const mockedExecLinear = vi.mocked(execLinear);
const mockedWithTempFile = vi.mocked(withTempFile);

function parse(result: { content: { type: string; text?: string }[] }) {
  const text = result.content.find((c) => c.type === "text")?.text;
  return text ? JSON.parse(text) : undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: withTempFile passes a fake path to the callback
  mockedWithTempFile.mockImplementation(async (_content, fn) => {
    return fn("/tmp/fake/content.md");
  });
});

describe("linear_comment_add tool", () => {
  it("has correct name and description", () => {
    const tool = createCommentAddTool();
    expect(tool.name).toBe("linear_comment_add");
    expect(tool.description).toContain("comment");
  });

  it("adds a comment successfully", async () => {
    mockedExecLinear.mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });

    const tool = createCommentAddTool();
    const result = await tool.execute("call-1", {
      issueId: "ENG-42",
      body: "Looks good!",
    });
    const data = parse(result);

    expect(data).toEqual({ success: true, issueId: "ENG-42" });
    expect(mockedWithTempFile).toHaveBeenCalledWith(
      "Looks good!",
      expect.any(Function),
    );
    expect(mockedExecLinear).toHaveBeenCalledWith([
      "issue",
      "comment",
      "add",
      "ENG-42",
      "--body-file",
      "/tmp/fake/content.md",
    ]);
  });

  it("passes parent comment ID when provided", async () => {
    mockedExecLinear.mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });

    const tool = createCommentAddTool();
    await tool.execute("call-1", {
      issueId: "ENG-42",
      body: "Reply",
      parentCommentId: "parent-abc",
    });

    expect(mockedExecLinear).toHaveBeenCalledWith([
      "issue",
      "comment",
      "add",
      "ENG-42",
      "--body-file",
      "/tmp/fake/content.md",
      "--parent",
      "parent-abc",
    ]);
  });

  it("returns error on non-zero exit code", async () => {
    mockedExecLinear.mockResolvedValue({
      stdout: "",
      stderr: "Permission denied",
      exitCode: 1,
    });

    const tool = createCommentAddTool();
    const result = await tool.execute("call-1", {
      issueId: "ENG-42",
      body: "test",
    });
    const data = parse(result);

    expect(data.error).toContain("Failed to add comment");
  });

  it("returns error when CLI throws", async () => {
    mockedExecLinear.mockRejectedValue(new Error("ENOENT"));

    const tool = createCommentAddTool();
    const result = await tool.execute("call-1", {
      issueId: "ENG-42",
      body: "test",
    });
    const data = parse(result);

    expect(data.error).toContain("linear CLI error");
  });
});
