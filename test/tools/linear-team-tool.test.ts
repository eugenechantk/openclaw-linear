import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/linear-api.js", () => ({
  graphql: vi.fn(),
}));

const { graphql } = await import("../../src/linear-api.js");
const { createTeamTool } = await import("../../src/tools/linear-team-tool.js");

const mockedGraphql = vi.mocked(graphql);

function parse(result: { content: { type: string; text?: string }[] }) {
  const text = result.content.find((c) => c.type === "text")?.text;
  return text ? JSON.parse(text) : undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("linear_team tool", () => {
  it("has correct name", () => {
    const tool = createTeamTool();
    expect(tool.name).toBe("linear_team");
  });

  describe("list", () => {
    it("returns all teams", async () => {
      mockedGraphql.mockResolvedValue({
        teams: {
          nodes: [
            { id: "t1", name: "Engineering", key: "ENG" },
            { id: "t2", name: "Operations", key: "OPS" },
          ],
        },
      });

      const tool = createTeamTool();
      const result = await tool.execute("call-1", { action: "list" });
      const data = parse(result);
      expect(data.teams).toHaveLength(2);
      expect(data.teams[0].key).toBe("ENG");
    });
  });

  describe("members", () => {
    it("returns members of a team", async () => {
      mockedGraphql.mockResolvedValue({
        teams: {
          nodes: [
            {
              members: {
                nodes: [
                  { id: "u1", name: "Alice", email: "alice@test.com" },
                  { id: "u2", name: "Bob", email: "bob@test.com" },
                ],
              },
            },
          ],
        },
      });

      const tool = createTeamTool();
      const result = await tool.execute("call-1", {
        action: "members",
        team: "ENG",
      });
      const data = parse(result);
      expect(data.members).toHaveLength(2);
      expect(data.members[0].name).toBe("Alice");
    });

    it("returns error without team", async () => {
      const tool = createTeamTool();
      const result = await tool.execute("call-1", { action: "members" });
      const data = parse(result);
      expect(data.error).toContain("team is required");
    });

    it("returns error when team not found", async () => {
      mockedGraphql.mockResolvedValue({ teams: { nodes: [] } });

      const tool = createTeamTool();
      const result = await tool.execute("call-1", {
        action: "members",
        team: "NOPE",
      });
      const data = parse(result);
      expect(data.error).toContain("not found");
    });
  });

  it("catches and returns API errors", async () => {
    mockedGraphql.mockRejectedValue(new Error("Network error"));

    const tool = createTeamTool();
    const result = await tool.execute("call-1", { action: "list" });
    const data = parse(result);
    expect(data.error).toContain("Network error");
  });
});
