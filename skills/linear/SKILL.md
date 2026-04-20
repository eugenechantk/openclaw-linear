---
name: linear
description: Linear project management integration. Provides tools for issue-scoped work lifecycle, issues, comments, teams, projects, and issue relations via the Linear GraphQL API.
metadata: { "openclaw": { "always": true, "emoji": "📐", "requires": { "config": ["extensions.openclaw-linear"] } } }
---

# Linear

You have Linear tools for managing issues and responding to notifications. These tools call the Linear GraphQL API directly — they handle auth, formatting, and error handling for you.

## Tools

### `linear_issue_work` — issue work lifecycle

Inspects and completes deterministic issue-scoped work records routed by webhooks. Normal Linear sessions should use this tool for lifecycle operations.

| Action | Effect |
|---|---|
| `view` | View one issue work record and recent Codex runs. |
| `complete` | Ask the dispatcher to reconcile completed work for an issue. |
| `recover` | Recover expired issue work leases. |
| `debug` | Read recent JSONL debug entries by issue, session, or webhook delivery. |

Issue work records are keyed by Linear issue identifier and include the session key, current intent, active/pending event IDs, follow-up comment IDs, Codex thread/run continuity, and lease state.

Use `issueId` when calling `linear_issue_work`, `linear_issue`, or `linear_comment`.

### `linear_queue` — compatibility/debug only

The old global queue-shaped tool remains for compatibility and manual debugging. Normal sessions should not `peek`, `claim`, `pop`, or `drain` this tool. If legacy instructions still call `linear_queue complete`, it delegates to the same dispatcher completion path as `linear_issue_work complete`.

Do not use `linear_queue` as the primary workflow.

### `linear_issue` — manage issues

Manage Linear issues: view details, search/filter, create, update, and delete.

| Action | Required Params | Optional Params |
|---|---|---|
| `view` | `issueId` | — |
| `list` | — | `state`, `assignee`, `team`, `project`, `limit` |
| `create` | `title` | `description`, `assignee`, `state`, `priority`, `team`, `project`, `parent`, `labels`, `dueDate` |
| `update` | `issueId` | `title`, `description`, `appendDescription`, `assignee`, `state`, `priority`, `labels`, `project`, `dueDate` |
| `delete` | `issueId` | — |

- `issueId` accepts human-readable identifiers like `ENG-123`
- `assignee` accepts display name or email
- `state` accepts workflow state name (e.g. `In Progress`, `Done`)
- `team` accepts team key (e.g. `ENG`)
- `priority` is numeric: 0=None, 1=Urgent, 2=High, 3=Medium, 4=Low
- `labels` is an array of label names
- `parent` accepts a parent issue identifier for creating sub-issues
- `appendDescription` (boolean) — when true, appends `description` to the existing description instead of replacing it (update only)
- `dueDate` accepts a date string in `YYYY-MM-DD` format (e.g. `2025-12-31`); pass an empty string to clear the due date
- `description` supports markdown. **Use actual newlines for line breaks, not `\n` escape sequences** — literal `\n` will appear as-is in the ticket instead of creating line breaks

### `linear_comment` — manage comments

Read, create, and update comments on Linear issues.

| Action | Required Params | Optional Params |
|---|---|---|
| `list` | `issueId` | — |
| `add` | `issueId`, `body` | `parentCommentId` |
| `update` | `commentId`, `body` | — |

- `body` supports markdown. **Use actual newlines for line breaks, not `\n` escape sequences** — literal `\n` will appear as-is in the comment instead of creating line breaks
- `parentCommentId` threads the comment as a reply

### `linear_team` — teams and members

View teams and their members.

| Action | Required Params | Optional Params |
|---|---|---|
| `list` | — | — |
| `members` | `team` | — |

- `team` is the team key (e.g. `ENG`)

### `linear_project` — manage projects

List, view, and create Linear projects.

| Action | Required Params | Optional Params |
|---|---|---|
| `list` | — | `team`, `status` |
| `view` | `projectId` | — |
| `create` | `name` | `team`, `description` |

### `linear_relation` — issue relations

Manage relations between Linear issues (blocks, blocked-by, related, duplicate).

| Action | Required Params | Optional Params |
|---|---|---|
| `list` | `issueId` | — |
| `add` | `issueId`, `type`, `relatedIssueId` | — |
| `delete` | `relationId` | — |

- `type` is one of: `blocks`, `blocked-by`, `related`, `duplicate`

## Processing workflow

When you receive a Linear notification:

1. Read the dispatcher-provided issue work packet. The dispatcher already claimed the work.
2. Read the issue with `linear_issue { action: "view", issueId: "<id>" }`.
3. Read comments with `linear_comment { action: "list", issueId: "<id>" }` when discussion context matters.
4. Act on the issue or follow-up.
5. Complete with `linear_issue_work { action: "complete", issueId: "<id>" }`.
