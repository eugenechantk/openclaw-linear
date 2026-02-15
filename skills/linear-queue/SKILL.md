---
name: linear-queue
description: Work queue processing for Linear notifications. Guides the agent through reading, prioritizing, and completing queued Linear items.
metadata: { "openclaw": { "always": true } }
---

# Linear Work Queue

You have a `linear_queue` tool for managing Linear notifications that need your attention. The tool is the source of truth — don't parse raw notification messages yourself.

## Queue tool actions

| Action | Effect |
|---|---|
| `peek` | View all pending items sorted by priority. Non-destructive. |
| `pop` | Remove and return the highest-priority item. |
| `drain` | Remove and return all items sorted by priority. |

## Queue item structure

```json
{
  "id": "TEAM-123",
  "issueId": "TEAM-123",
  "event": "ticket",
  "summary": "Issue title or comment text",
  "priority": 1,
  "addedAt": "ISO timestamp"
}
```

## Event types and expected actions

| Event | Action |
|---|---|
| `ticket` | You have a ticket to work on. Read issue details and begin work. |
| `mention` | You were mentioned in a comment. Read and respond. |

Priority is determined by the Linear issue's priority (1=Urgent, 2=High, 3=Medium, 4=Low, 5=None). Higher-priority items are popped first.

## Linear tools

Use these tools to interact with Linear issues:

| Tool | Purpose |
|---|---|
| `linear_issue_view` | View full issue details (title, description, state, assignee, priority, labels) |
| `linear_comment_list` | List all comments on an issue |
| `linear_comment_add` | Add a comment to an issue (supports markdown, threading) |
| `linear_issue_update` | Update issue properties (state, assignee, priority, labels, title, description, project) |
| `linear_issue_create` | Create a new issue or sub-issue |

## Processing workflow

1. **Peek** the queue with `linear_queue { action: "peek" }` to see all pending items.
2. **Skip** if there are no items.
3. **Pop** the next item with `linear_queue { action: "pop" }`.
4. **Read** the issue with `linear_issue_view { issueId: "<id>" }` to understand the full context.
5. **Read comments** with `linear_comment_list { issueId: "<id>" }` if the event is a mention or you need discussion context.
6. **Act** on the item:
   - For `ticket` events: do the work, then update the issue state with `linear_issue_update`.
   - For `mention` events: read the comment thread, then reply with `linear_comment_add`.
7. **Repeat** from step 3 until pop returns null.
