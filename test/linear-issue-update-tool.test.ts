import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/linear-cli.js", () => ({
  execLinear: vi.fn(),
  withTempFile: vi.fn(),
}));

const { execLinear, withTempFile } = await import("../src/linear-cli.js");
const { createIssueUpdateTool } = await import("../src/linear-issue-update-tool.js");

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

describe("linear_issue_update tool", () => {
  it("has correct name and description", () => {
    const tool = createIssueUpdateTool();
    expect(tool.name).toBe("linear_issue_update");
    expect(tool.description).toContain("Update");
  });

  it("updates state and assignee", async () => {
    mockedExecLinear.mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });

    const tool = createIssueUpdateTool();
    const result = await tool.execute("call-1", {
      issueId: "ENG-42",
      state: "In Progress",
      assignee: "alice@example.com",
    });
    const data = parse(result);

    expect(data).toEqual({ success: true, issueId: "ENG-42" });
    expect(mockedExecLinear).toHaveBeenCalledWith([
      "issue",
      "update",
      "ENG-42",
      "--state",
      "In Progress",
      "--assignee",
      "alice@example.com",
    ]);
  });

  it("uses temp file for description", async () => {
    mockedExecLinear.mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });

    const tool = createIssueUpdateTool();
    await tool.execute("call-1", {
      issueId: "ENG-42",
      description: "# New description\n\nWith markdown",
    });

    expect(mockedWithTempFile).toHaveBeenCalledWith(
      "# New description\n\nWith markdown",
      expect.any(Function),
    );
    expect(mockedExecLinear).toHaveBeenCalledWith([
      "issue",
      "update",
      "ENG-42",
      "--description-file",
      "/tmp/fake/content.md",
    ]);
  });

  it("passes labels as repeated --label flags", async () => {
    mockedExecLinear.mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });

    const tool = createIssueUpdateTool();
    await tool.execute("call-1", {
      issueId: "ENG-42",
      labels: ["bug", "urgent"],
    });

    expect(mockedExecLinear).toHaveBeenCalledWith([
      "issue",
      "update",
      "ENG-42",
      "--label",
      "bug",
      "--label",
      "urgent",
    ]);
  });

  it("passes all optional fields", async () => {
    mockedExecLinear.mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });

    const tool = createIssueUpdateTool();
    await tool.execute("call-1", {
      issueId: "ENG-42",
      state: "Done",
      assignee: "bob",
      priority: "High",
      title: "New title",
      project: "Q1 Sprint",
      labels: ["feature"],
      description: "desc",
    });

    expect(mockedWithTempFile).toHaveBeenCalled();
    expect(mockedExecLinear).toHaveBeenCalledWith([
      "issue",
      "update",
      "ENG-42",
      "--state",
      "Done",
      "--assignee",
      "bob",
      "--priority",
      "High",
      "--title",
      "New title",
      "--project",
      "Q1 Sprint",
      "--label",
      "feature",
      "--description-file",
      "/tmp/fake/content.md",
    ]);
  });

  it("returns error on non-zero exit code", async () => {
    mockedExecLinear.mockResolvedValue({
      stdout: "",
      stderr: "State not found",
      exitCode: 1,
    });

    const tool = createIssueUpdateTool();
    const result = await tool.execute("call-1", {
      issueId: "ENG-42",
      state: "Bogus",
    });
    const data = parse(result);

    expect(data.error).toContain("Failed to update issue ENG-42");
  });

  it("returns error when CLI throws", async () => {
    mockedExecLinear.mockRejectedValue(new Error("ENOENT"));

    const tool = createIssueUpdateTool();
    const result = await tool.execute("call-1", {
      issueId: "ENG-42",
      state: "Done",
    });
    const data = parse(result);

    expect(data.error).toContain("linear CLI error");
  });
});
