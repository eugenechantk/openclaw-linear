---
name: linear
description: Linear project management integration. Provides tools for processing a notification queue, viewing and updating issues, and managing comments. Includes direct CLI access for advanced operations.
metadata: { "openclaw": { "always": true } }
---

# Linear

You have Linear tools for managing issues and responding to notifications. These tools call the `linear` CLI under the hood — they handle auth, formatting, and error handling for you.

For operations not covered by the tools, you can call the `linear` CLI directly via Bash.

## Tools

### `linear_queue` — notification inbox

Manages the queue of Linear notifications routed to you by webhooks.

| Action | Effect |
|---|---|
| `peek` | View all pending items sorted by priority. Non-destructive. |
| `pop` | Claim the highest-priority pending item (marks it `in_progress`). |
| `drain` | Claim all pending items (marks them `in_progress`). |
| `complete` | Finish work on a claimed item (requires `issueId`). Removes it from the queue. |

Queue items have this shape:

```json
{
  "id": "TEAM-123",
  "issueId": "TEAM-123",
  "event": "ticket",
  "summary": "Issue title or comment text",
  "priority": 1,
  "status": "pending",
  "addedAt": "ISO timestamp"
}
```

Event types:

| Event | Meaning |
|---|---|
| `ticket` | You have a ticket to work on. |
| `mention` | You were mentioned in a comment. |

Priority maps from the Linear issue (1=Urgent, 2=High, 3=Medium, 4=Low, 5=None). Higher-priority items are popped first.

### `linear_issue_view` — read an issue

Returns the full issue object: title, description, state, assignee, priority, labels, and more.

| Param | Required | Description |
|---|---|---|
| `issueId` | yes | Issue identifier (e.g. `ENG-123`) |

### `linear_issue_update` — change issue properties

Updates one or more fields on an existing issue.

| Param | Required | Description |
|---|---|---|
| `issueId` | yes | Issue identifier |
| `state` | no | Workflow state name (e.g. `In Progress`, `Done`) |
| `assignee` | no | Display name or email |
| `priority` | no | `Urgent`, `High`, `Medium`, `Low`, or `None` |
| `title` | no | New title |
| `description` | no | New description (markdown) |
| `labels` | no | Array of label names |
| `project` | no | Project name |

### `linear_issue_create` — create an issue

Creates a new issue. Returns the identifier and URL.

| Param | Required | Description |
|---|---|---|
| `title` | yes | Issue title |
| `description` | no | Description (markdown) |
| `assignee` | no | Display name or email |
| `state` | no | Initial workflow state |
| `priority` | no | Priority level |
| `labels` | no | Array of label names |
| `team` | no | Team key (e.g. `ENG`). Required if you belong to multiple teams. |
| `project` | no | Project name |
| `parent` | no | Parent issue identifier for sub-issues (e.g. `ENG-100`) |

### `linear_comment_list` — read comments

Returns all comments on an issue as a JSON array.

| Param | Required | Description |
|---|---|---|
| `issueId` | yes | Issue identifier |

### `linear_comment_add` — post a comment

Adds a comment to an issue. Supports markdown and threading.

| Param | Required | Description |
|---|---|---|
| `issueId` | yes | Issue identifier |
| `body` | yes | Comment body (markdown) |
| `parentCommentId` | no | Parent comment ID to reply as a thread |

## Processing workflow

When you receive a Linear notification:

1. **Peek** with `linear_queue { action: "peek" }` to see all pending items.
2. **Skip** if there are no items.
3. **Pop** the next item with `linear_queue { action: "pop" }`. This claims it (status becomes `in_progress`).
4. **Read** the issue with `linear_issue_view { issueId: "<id>" }`.
5. **Read comments** with `linear_comment_list { issueId: "<id>" }` if the event is a mention or you need discussion context.
6. **Act** on the item:
   - `ticket` — do the work, then update state with `linear_issue_update`.
   - `mention` — read the thread and reply with `linear_comment_add`.
7. **Complete** with `linear_queue { action: "complete", issueId: "<id>" }` to remove it from the queue.
8. **Repeat** from step 3 until pop returns null.

## Linear CLI reference

The tools above cover the most common operations. For anything else, call the `linear` CLI directly. Use `--help` on any command to see available flags:

```bash
linear --help
linear issue --help
linear issue list --help
```

### Best practices for markdown content

When passing markdown via the CLI directly, **always use file-based flags** instead of inline arguments:

- `--description-file` for `issue create` and `issue update`
- `--body-file` for `comment add` and `comment update`

This avoids shell escaping issues with newlines and special characters. The tools handle this automatically.

```bash
cat > /tmp/description.md <<'EOF'
## Summary

- First item
- Second item
EOF

linear issue create --title "My Issue" --description-file /tmp/description.md
```

Only use inline flags (`--description`, `--body`) for simple, single-line content.

### Issue commands

```
linear issue list           # List your issues (filters: --state, --assignee, --team, --project)
linear issue view <id>      # View issue details (--json for structured output)
linear issue create         # Create an issue (--title, --description-file, --assignee, --state, --priority, --label, --team, --project, --parent)
linear issue update <id>    # Update an issue (--title, --state, --assignee, --priority, --label, --description-file, --project)
linear issue start <id>     # Start working on an issue (sets state + creates branch)
linear issue delete <id>    # Delete an issue (--confirm to skip prompt)
linear issue url <id>       # Print the issue URL
linear issue attach <id> <file>  # Attach a file to an issue
```

### Comment commands

```
linear issue comment add <id>     # Add a comment (--body-file, --parent for threading, --attach for files)
linear issue comment update <id>  # Update a comment (--body-file)
linear issue comment list <id>    # List comments (--json for structured output)
```

### Issue relations

```
linear issue relation add <id> <type> <relatedId>     # Add relation (blocked-by, blocks, related, duplicate)
linear issue relation delete <id> <type> <relatedId>   # Remove relation
linear issue relation list <id>                        # List relations
```

### Project commands

```
linear project list              # List projects (--team, --status)
linear project view <projectId>  # View project details
linear project create            # Create project (--name, --team, --lead, --status, --description)
```

### Team commands

```
linear team list              # List teams
linear team members [teamKey] # List team members
```

### Using the GraphQL API directly

**Prefer the CLI for all supported operations.** Use `linear api` only as a fallback for queries not covered by the CLI.

```bash
# Simple query
linear api '{ viewer { id name email } }'

# Query with variables — use heredoc to avoid escaping issues
linear api --variable teamId=abc123 <<'GRAPHQL'
query($teamId: String!) { team(id: $teamId) { name } }
GRAPHQL

# Search issues by text
linear api --variable term=onboarding <<'GRAPHQL'
query($term: String!) { searchIssues(term: $term, first: 20) { nodes { identifier title state { name } } } }
GRAPHQL

# Complex filters via JSON
linear api --variables-json '{"filter": {"state": {"name": {"eq": "In Progress"}}}}' <<'GRAPHQL'
query($filter: IssueFilter!) { issues(filter: $filter) { nodes { title } } }
GRAPHQL

# Pipe to jq for filtering
linear api '{ issues(first: 5) { nodes { identifier title } } }' | jq '.data.issues.nodes[].title'
```

To check available types and fields:

```bash
linear schema -o "${TMPDIR:-/tmp}/linear-schema.graphql"
grep -A 30 "^type Issue " "${TMPDIR:-/tmp}/linear-schema.graphql"
```
