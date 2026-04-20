const API_URL = "https://api.linear.app/graphql";

let apiKey: string | undefined;

export function setApiKey(key: string): void {
  apiKey = key;
}

/** Reset API key (for testing). */
export function _resetApiKey(): void {
  apiKey = undefined;
}

export async function graphql<T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  if (!apiKey) {
    throw new Error("Linear API key not set — call setApiKey() first");
  }

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      Authorization: apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.text();
      if (body) detail += `: ${body}`;
    } catch {
      // ignore read errors
    }
    throw new Error(`Linear API HTTP ${res.status}: ${detail}`);
  }

  const json = (await res.json()) as {
    data?: T;
    errors?: { message: string }[];
  };

  if (json.errors?.length) {
    throw new Error(`Linear API error: ${json.errors[0].message}`);
  }

  return json.data as T;
}

// --- Name/ID resolution helpers ---

// --- Issue context fetcher for dispatch messages ---

export interface IssueContext {
  identifier: string;
  title: string;
  description: string | null;
  state: string | null;
  priority: string | null;
  assignee: string | null;
  comments: { author: string; body: string; createdAt: string }[];
}

export interface IssueWorkflowState {
  id: string;
  identifier: string;
  teamId: string;
  stateName: string | null;
  stateType: string | null;
}

export interface LinearViewer {
  id: string;
  name: string | null;
  email: string | null;
}

export interface IssueAssigneeUpdate {
  id: string;
  identifier: string;
  assignee: LinearViewer | null;
}

function looksLikeIssueIdentifier(value: string): boolean {
  return /^[A-Za-z]+-\d+$/.test(value);
}

async function resolveIssueRef(ref: string): Promise<string> {
  return looksLikeIssueIdentifier(ref) ? resolveIssueId(ref) : ref;
}

export async function fetchIssueContext(identifier: string): Promise<IssueContext | null> {
  const match = identifier.match(/^([A-Za-z]+)-(\d+)$/);
  if (!match) return null;

  const [, teamKey, numStr] = match;
  const num = parseInt(numStr, 10);

  try {
    const data = await graphql<{
      issues: {
        nodes: {
          identifier: string;
          title: string;
          description: string | null;
          state: { name: string } | null;
          priorityLabel: string | null;
          assignee: { name: string } | null;
          comments: {
            nodes: {
              body: string;
              createdAt: string;
              user: { name: string } | null;
            }[];
          };
        }[];
      };
    }>(
      `query($teamKey: String!, $num: Float!) {
        issues(filter: { team: { key: { eq: $teamKey } }, number: { eq: $num } }) {
          nodes {
            identifier
            title
            description
            state { name }
            priorityLabel
            assignee { name }
            comments(first: 10, orderBy: createdAt) {
              nodes {
                body
                createdAt
                user { name }
              }
            }
          }
        }
      }`,
      { teamKey: teamKey.toUpperCase(), num },
    );

    if (data.issues.nodes.length === 0) return null;

    const issue = data.issues.nodes[0];
    return {
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description,
      state: issue.state?.name ?? null,
      priority: issue.priorityLabel ?? null,
      assignee: issue.assignee?.name ?? null,
      comments: issue.comments.nodes.map((c) => ({
        author: c.user?.name ?? "Unknown",
        body: c.body,
        createdAt: c.createdAt,
      })),
    };
  } catch {
    return null;
  }
}

const issueIdCache = new Map<string, string>();

export async function resolveIssueId(identifier: string): Promise<string> {
  const cached = issueIdCache.get(identifier);
  if (cached) return cached;

  const match = identifier.match(/^([A-Za-z]+)-(\d+)$/);
  if (!match) {
    throw new Error(`Invalid issue identifier format: ${identifier} (expected e.g. ENG-123)`);
  }

  const [, teamKey, numStr] = match;
  const num = parseInt(numStr, 10);

  const data = await graphql<{
    issues: { nodes: { id: string }[] };
  }>(
    `query($teamKey: String!, $num: Float!) {
      issues(filter: { team: { key: { eq: $teamKey } }, number: { eq: $num } }) {
        nodes { id }
      }
    }`,
    { teamKey: teamKey.toUpperCase(), num },
  );

  if (data.issues.nodes.length === 0) {
    throw new Error(`Issue ${identifier} not found`);
  }

  const id = data.issues.nodes[0].id;
  issueIdCache.set(identifier, id);
  return id;
}

export async function fetchIssueWorkflowState(issueRef: string): Promise<IssueWorkflowState | null> {
  const issueId = await resolveIssueRef(issueRef);

  const data = await graphql<{
    issue: {
      id: string;
      identifier: string;
      team: { id: string } | null;
      state: { name: string; type: string } | null;
    } | null;
  }>(
    `query($id: String!) {
      issue(id: $id) {
        id
        identifier
        team { id }
        state { name type }
      }
    }`,
    { id: issueId },
  );

  if (!data.issue || !data.issue.team) return null;

  return {
    id: data.issue.id,
    identifier: data.issue.identifier,
    teamId: data.issue.team.id,
    stateName: data.issue.state?.name ?? null,
    stateType: data.issue.state?.type ?? null,
  };
}

export async function fetchViewer(): Promise<LinearViewer> {
  const data = await graphql<{
    viewer: {
      id: string;
      name: string | null;
      email: string | null;
    };
  }>(
    `query {
      viewer {
        id
        name
        email
      }
    }`,
  );

  return data.viewer;
}

export async function updateIssueAssignee(
  issueRef: string,
  assigneeId: string,
): Promise<IssueAssigneeUpdate | null> {
  const issueId = await resolveIssueRef(issueRef);
  const data = await graphql<{
    issueUpdate: {
      success: boolean;
      issue: {
        id: string;
        identifier: string;
        assignee: {
          id: string;
          name: string | null;
          email: string | null;
        } | null;
      } | null;
    };
  }>(
    `mutation($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) {
        success
        issue {
          id
          identifier
          assignee { id name email }
        }
      }
    }`,
    { id: issueId, input: { assigneeId } },
  );

  return data.issueUpdate.success ? data.issueUpdate.issue : null;
}

export async function assignIssueToViewer(issueRef: string): Promise<IssueAssigneeUpdate | null> {
  const viewer = await fetchViewer();
  return updateIssueAssignee(issueRef, viewer.id);
}

export async function updateIssueStateByName(issueRef: string, stateName: string): Promise<IssueWorkflowState | null> {
  const current = await fetchIssueWorkflowState(issueRef);
  if (!current) return null;

  const stateId = await resolveStateId(current.teamId, stateName);
  const data = await graphql<{
    issueUpdate: {
      success: boolean;
      issue: {
        id: string;
        identifier: string;
        team: { id: string } | null;
        state: { name: string; type: string } | null;
      } | null;
    };
  }>(
    `mutation($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) {
        success
        issue {
          id
          identifier
          team { id }
          state { name type }
        }
      }
    }`,
    { id: current.id, input: { stateId } },
  );

  const issue = data.issueUpdate.issue;
  if (!issue || !issue.team) return null;

  return {
    id: issue.id,
    identifier: issue.identifier,
    teamId: issue.team.id,
    stateName: issue.state?.name ?? null,
    stateType: issue.state?.type ?? null,
  };
}

export async function createIssueComment(
  issueRef: string,
  body: string,
  parentCommentId?: string,
): Promise<{ id: string; body: string } | null> {
  const issueId = await resolveIssueRef(issueRef);
  const input: Record<string, unknown> = { issueId, body };
  if (parentCommentId) input.parentId = parentCommentId;

  const data = await graphql<{
    commentCreate: {
      success: boolean;
      comment: { id: string; body: string } | null;
    };
  }>(
    `mutation($input: CommentCreateInput!) {
      commentCreate(input: $input) {
        success
        comment { id body }
      }
    }`,
    { input },
  );

  return data.commentCreate.success ? data.commentCreate.comment : null;
}

export async function issueHasRecentCommentBody(
  issueRef: string,
  body: string,
  first = 20,
): Promise<boolean> {
  const issueId = await resolveIssueRef(issueRef);
  const data = await graphql<{
    issue: {
      comments: {
        nodes: { body: string }[];
      };
    } | null;
  }>(
    `query($id: String!, $first: Int!) {
      issue(id: $id) {
        comments(first: $first, orderBy: createdAt) {
          nodes { body }
        }
      }
    }`,
    { id: issueId, first },
  );

  return data.issue?.comments.nodes.some((comment) => comment.body.trim() === body.trim()) ?? false;
}

/** Reset issue ID cache (for testing). */
export function _resetIssueIdCache(): void {
  issueIdCache.clear();
}

export async function resolveTeamId(key: string): Promise<string> {
  const data = await graphql<{
    teams: { nodes: { id: string }[] };
  }>(
    `query($key: String!) {
      teams(filter: { key: { eq: $key } }) {
        nodes { id }
      }
    }`,
    { key: key.toUpperCase() },
  );

  if (data.teams.nodes.length === 0) {
    throw new Error(`Team with key "${key}" not found`);
  }
  return data.teams.nodes[0].id;
}

export async function resolveStateId(
  teamId: string,
  stateName: string,
): Promise<string> {
  const data = await graphql<{
    team: { states: { nodes: { id: string; name: string }[] } };
  }>(
    `query($teamId: String!) {
      team(id: $teamId) {
        states { nodes { id name } }
      }
    }`,
    { teamId },
  );

  const lowerName = stateName.toLowerCase();
  const match = data.team.states.nodes.find(
    (s) => s.name.toLowerCase() === lowerName,
  );

  if (!match) {
    const available = data.team.states.nodes.map((s) => s.name).join(", ");
    throw new Error(
      `Workflow state "${stateName}" not found. Available states: ${available}`,
    );
  }
  return match.id;
}

export async function resolveUserId(nameOrEmail: string): Promise<string> {
  const data = await graphql<{
    users: { nodes: { id: string }[] };
  }>(
    `query($term: String!) {
      users(filter: { or: [{ name: { eqIgnoreCase: $term } }, { email: { eq: $term } }] }) {
        nodes { id }
      }
    }`,
    { term: nameOrEmail },
  );

  if (data.users.nodes.length === 0) {
    throw new Error(`User "${nameOrEmail}" not found`);
  }
  return data.users.nodes[0].id;
}

export async function resolveLabelIds(
  teamId: string,
  names: string[],
): Promise<string[]> {
  const data = await graphql<{
    team: { labels: { nodes: { id: string; name: string }[] } };
  }>(
    `query($teamId: String!) {
      team(id: $teamId) {
        labels { nodes { id name } }
      }
    }`,
    { teamId },
  );

  const labelMap = new Map(
    data.team.labels.nodes.map((l) => [l.name.toLowerCase(), l.id]),
  );

  const ids: string[] = [];
  for (const name of names) {
    const id = labelMap.get(name.toLowerCase());
    if (!id) {
      throw new Error(`Label "${name}" not found in team`);
    }
    ids.push(id);
  }
  return ids;
}

export async function resolveProjectId(name: string): Promise<string> {
  const data = await graphql<{
    projects: { nodes: { id: string; name: string }[] };
  }>(
    `query($name: String!) {
      projects(filter: { name: { eqIgnoreCase: $name } }) {
        nodes { id name }
      }
    }`,
    { name },
  );

  if (data.projects.nodes.length === 0) {
    throw new Error(`Project "${name}" not found`);
  }
  return data.projects.nodes[0].id;
}
