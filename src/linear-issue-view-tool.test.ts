import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./linear-cli.js", () => ({
  execLinear: vi.fn(),
}));

const { execLinear } = await import("./linear-cli.js");
const { createIssueViewTool } = await import("./linear-issue-view-tool.js");

const mockedExecLinear = vi.mocked(execLinear);

function parse(result: { content: { type: string; text?: string }[] }) {
  const text = result.content.find((c) => c.type === "text")?.text;
  return text ? JSON.parse(text) : undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("linear_issue_view tool", () => {
  it("has correct name and description", () => {
    const tool = createIssueViewTool();
    expect(tool.name).toBe("linear_issue_view");
    expect(tool.description).toContain("View");
  });

  it("returns parsed JSON on success", async () => {
    const issue = { id: "abc", title: "Fix bug", state: { name: "Todo" } };
    mockedExecLinear.mockResolvedValue({
      stdout: JSON.stringify(issue),
      stderr: "",
      exitCode: 0,
    });

    const tool = createIssueViewTool();
    const result = await tool.execute("call-1", { issueId: "ENG-42" });
    const data = parse(result);

    expect(data).toEqual(issue);
    expect(mockedExecLinear).toHaveBeenCalledWith([
      "issue",
      "view",
      "ENG-42",
      "--json",
    ]);
  });

  it("returns error on non-zero exit code", async () => {
    mockedExecLinear.mockResolvedValue({
      stdout: "",
      stderr: "Issue not found",
      exitCode: 1,
    });

    const tool = createIssueViewTool();
    const result = await tool.execute("call-1", { issueId: "NOPE-1" });
    const data = parse(result);

    expect(data.error).toContain("Failed to view issue NOPE-1");
    expect(data.error).toContain("Issue not found");
  });

  it("returns error when CLI throws (e.g. binary not found)", async () => {
    mockedExecLinear.mockRejectedValue(new Error("ENOENT"));

    const tool = createIssueViewTool();
    const result = await tool.execute("call-1", { issueId: "ENG-1" });
    const data = parse(result);

    expect(data.error).toContain("linear CLI error");
    expect(data.error).toContain("ENOENT");
  });
});
