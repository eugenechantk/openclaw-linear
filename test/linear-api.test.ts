import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  graphql,
  setApiKey,
  _resetApiKey,
  resolveIssueId,
  _resetIssueIdCache,
  resolveTeamId,
  resolveStateId,
  resolveUserId,
  resolveLabelIds,
  resolveProjectId,
} from "../src/linear-api.js";

const mockFetch = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", mockFetch);
  _resetApiKey();
  _resetIssueIdCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockGraphqlResponse(data: unknown) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ data }),
  });
}

function mockGraphqlError(message: string) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ errors: [{ message }] }),
  });
}

describe("graphql", () => {
  it("throws if API key is not set", async () => {
    await expect(graphql("{ viewer { id } }")).rejects.toThrow(
      "API key not set",
    );
  });

  it("sends correct headers and body", async () => {
    setApiKey("lin_api_test123");
    mockGraphqlResponse({ viewer: { id: "u1" } });

    await graphql("{ viewer { id } }");

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.linear.app/graphql",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "lin_api_test123",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: "{ viewer { id } }" }),
      }),
    );
  });

  it("returns data on success", async () => {
    setApiKey("lin_api_test");
    mockGraphqlResponse({ viewer: { id: "u1", name: "Test" } });

    const result = await graphql<{ viewer: { id: string; name: string } }>(
      "{ viewer { id name } }",
    );
    expect(result.viewer).toEqual({ id: "u1", name: "Test" });
  });

  it("passes variables", async () => {
    setApiKey("lin_api_test");
    mockGraphqlResponse({ issue: { id: "i1" } });

    await graphql("query($id: String!) { issue(id: $id) { id } }", {
      id: "i1",
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.variables).toEqual({ id: "i1" });
  });

  it("throws on HTTP error with response body", async () => {
    setApiKey("lin_api_test");
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: async () => '{"error":"Invalid API key"}',
    });

    await expect(graphql("{ viewer { id } }")).rejects.toThrow(
      'HTTP 401: Unauthorized: {"error":"Invalid API key"}',
    );
  });

  it("throws on HTTP error without response body", async () => {
    setApiKey("lin_api_test");
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      text: async () => "",
    });

    await expect(graphql("{ viewer { id } }")).rejects.toThrow(
      "HTTP 500: Internal Server Error",
    );
  });

  it("throws on GraphQL error", async () => {
    setApiKey("lin_api_test");
    mockGraphqlError("Entity not found");

    await expect(graphql("{ issue(id: \"bad\") { id } }")).rejects.toThrow(
      "Entity not found",
    );
  });
});

describe("resolveIssueId", () => {
  beforeEach(() => {
    setApiKey("lin_api_test");
  });

  it("resolves a valid identifier", async () => {
    mockGraphqlResponse({
      issues: { nodes: [{ id: "uuid-123" }] },
    });

    const id = await resolveIssueId("ENG-42");
    expect(id).toBe("uuid-123");
  });

  it("caches resolved IDs", async () => {
    mockGraphqlResponse({
      issues: { nodes: [{ id: "uuid-123" }] },
    });

    await resolveIssueId("ENG-42");
    const id2 = await resolveIssueId("ENG-42");
    expect(id2).toBe("uuid-123");
    expect(mockFetch).toHaveBeenCalledTimes(1); // Only one API call
  });

  it("throws on invalid format", async () => {
    await expect(resolveIssueId("bad-format-123")).rejects.toThrow(
      "Invalid issue identifier format",
    );
  });

  it("throws when issue not found", async () => {
    mockGraphqlResponse({ issues: { nodes: [] } });
    await expect(resolveIssueId("ENG-999")).rejects.toThrow(
      "Issue ENG-999 not found",
    );
  });
});

describe("resolveTeamId", () => {
  beforeEach(() => {
    setApiKey("lin_api_test");
  });

  it("resolves team by key", async () => {
    mockGraphqlResponse({ teams: { nodes: [{ id: "team-1" }] } });
    const id = await resolveTeamId("ENG");
    expect(id).toBe("team-1");
  });

  it("throws when team not found", async () => {
    mockGraphqlResponse({ teams: { nodes: [] } });
    await expect(resolveTeamId("NOPE")).rejects.toThrow('Team with key "NOPE" not found');
  });
});

describe("resolveStateId", () => {
  beforeEach(() => {
    setApiKey("lin_api_test");
  });

  it("resolves state by name and team", async () => {
    mockGraphqlResponse({
      team: {
        states: {
          nodes: [
            { id: "state-1", name: "In Progress" },
            { id: "state-2", name: "Done" },
          ],
        },
      },
    });
    const id = await resolveStateId("team-1", "In Progress");
    expect(id).toBe("state-1");
  });

  it("is case-insensitive", async () => {
    mockGraphqlResponse({
      team: {
        states: { nodes: [{ id: "state-1", name: "In Progress" }] },
      },
    });
    const id = await resolveStateId("team-1", "in progress");
    expect(id).toBe("state-1");
  });

  it("throws when state not found with available states", async () => {
    mockGraphqlResponse({
      team: {
        states: {
          nodes: [
            { id: "state-1", name: "Todo" },
            { id: "state-2", name: "Done" },
          ],
        },
      },
    });
    await expect(resolveStateId("team-1", "Nonexistent")).rejects.toThrow(
      'Workflow state "Nonexistent" not found. Available states: Todo, Done',
    );
  });
});

describe("resolveUserId", () => {
  beforeEach(() => {
    setApiKey("lin_api_test");
  });

  it("resolves user by name or email", async () => {
    mockGraphqlResponse({ users: { nodes: [{ id: "user-1" }] } });
    const id = await resolveUserId("Alice");
    expect(id).toBe("user-1");
  });

  it("throws when user not found", async () => {
    mockGraphqlResponse({ users: { nodes: [] } });
    await expect(resolveUserId("nobody")).rejects.toThrow('User "nobody" not found');
  });
});

describe("resolveLabelIds", () => {
  beforeEach(() => {
    setApiKey("lin_api_test");
  });

  it("resolves label names to IDs", async () => {
    mockGraphqlResponse({
      team: {
        labels: {
          nodes: [
            { id: "l1", name: "Bug" },
            { id: "l2", name: "Feature" },
          ],
        },
      },
    });
    const ids = await resolveLabelIds("team-1", ["Bug", "Feature"]);
    expect(ids).toEqual(["l1", "l2"]);
  });

  it("is case-insensitive", async () => {
    mockGraphqlResponse({
      team: {
        labels: { nodes: [{ id: "l1", name: "Bug" }] },
      },
    });
    const ids = await resolveLabelIds("team-1", ["bug"]);
    expect(ids).toEqual(["l1"]);
  });

  it("throws when label not found", async () => {
    mockGraphqlResponse({
      team: { labels: { nodes: [{ id: "l1", name: "Bug" }] } },
    });
    await expect(resolveLabelIds("team-1", ["Missing"])).rejects.toThrow(
      'Label "Missing" not found in team',
    );
  });
});

describe("resolveProjectId", () => {
  beforeEach(() => {
    setApiKey("lin_api_test");
  });

  it("resolves project by name", async () => {
    mockGraphqlResponse({
      projects: { nodes: [{ id: "proj-1", name: "Alpha" }] },
    });
    const id = await resolveProjectId("Alpha");
    expect(id).toBe("proj-1");
  });

  it("throws when project not found", async () => {
    mockGraphqlResponse({ projects: { nodes: [] } });
    await expect(resolveProjectId("Nonexistent")).rejects.toThrow(
      'Project "Nonexistent" not found',
    );
  });
});
