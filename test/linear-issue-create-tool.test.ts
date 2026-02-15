import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/linear-cli.js", () => ({
  execLinear: vi.fn(),
  withTempFile: vi.fn(),
}));

const { execLinear, withTempFile } = await import("../src/linear-cli.js");
const { createIssueCreateTool } = await import("../src/linear-issue-create-tool.js");

const mockedExecLinear = vi.mocked(execLinear);
const mockedWithTempFile = vi.mocked(withTempFile);

function parse(result: { content: { type: string; text?: string }[] }) {
  const text = result.content.find((c) => c.type === "text")?.text;
  return text ? JSON.parse(text) : undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedWithTempFile.mockImplementation(async (_content, fn) => {
    return fn("/tmp/fake/content.md");
  });
});

describe("linear_issue_create tool", () => {
  it("has correct name and description", () => {
    const tool = createIssueCreateTool();
    expect(tool.name).toBe("linear_issue_create");
    expect(tool.description).toContain("Create");
  });

  it("creates issue with title only", async () => {
    mockedExecLinear.mockResolvedValue({
      stdout: "ENG-99 https://linear.app/eng/issue/ENG-99",
      stderr: "",
      exitCode: 0,
    });

    const tool = createIssueCreateTool();
    const result = await tool.execute("call-1", { title: "New bug" });
    const data = parse(result);

    expect(data).toEqual({
      success: true,
      stdout: "ENG-99 https://linear.app/eng/issue/ENG-99",
    });
    expect(mockedExecLinear).toHaveBeenCalledWith([
      "issue",
      "create",
      "--title",
      "New bug",
      "--no-interactive",
    ]);
  });

  it("creates issue with all optional fields", async () => {
    mockedExecLinear.mockResolvedValue({
      stdout: "ENG-100",
      stderr: "",
      exitCode: 0,
    });

    const tool = createIssueCreateTool();
    await tool.execute("call-1", {
      title: "Sub-task",
      description: "Details here",
      assignee: "alice",
      state: "Todo",
      priority: "High",
      team: "ENG",
      project: "Q1",
      parent: "ENG-50",
      labels: ["bug", "p0"],
    });

    expect(mockedWithTempFile).toHaveBeenCalledWith(
      "Details here",
      expect.any(Function),
    );
    expect(mockedExecLinear).toHaveBeenCalledWith([
      "issue",
      "create",
      "--title",
      "Sub-task",
      "--no-interactive",
      "--assignee",
      "alice",
      "--state",
      "Todo",
      "--priority",
      "High",
      "--team",
      "ENG",
      "--project",
      "Q1",
      "--parent",
      "ENG-50",
      "--label",
      "bug",
      "--label",
      "p0",
      "--description-file",
      "/tmp/fake/content.md",
    ]);
  });

  it("skips withTempFile when no description", async () => {
    mockedExecLinear.mockResolvedValue({
      stdout: "ENG-101",
      stderr: "",
      exitCode: 0,
    });

    const tool = createIssueCreateTool();
    await tool.execute("call-1", { title: "No desc" });

    expect(mockedWithTempFile).not.toHaveBeenCalled();
  });

  it("returns error on non-zero exit code", async () => {
    mockedExecLinear.mockResolvedValue({
      stdout: "",
      stderr: "Team not found",
      exitCode: 1,
    });

    const tool = createIssueCreateTool();
    const result = await tool.execute("call-1", { title: "Fail" });
    const data = parse(result);

    expect(data.error).toContain("Failed to create issue");
  });

  it("returns error when CLI throws", async () => {
    mockedExecLinear.mockRejectedValue(new Error("ENOENT"));

    const tool = createIssueCreateTool();
    const result = await tool.execute("call-1", { title: "Fail" });
    const data = parse(result);

    expect(data.error).toContain("linear CLI error");
  });
});
