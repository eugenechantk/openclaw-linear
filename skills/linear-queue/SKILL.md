---
name: linear-queue
description: Work queue processing for Linear notifications. Guides the agent through reading, prioritizing, and completing queued Linear items.
metadata: { "openclaw": { "always": true } }
---

# Linear Work Queue

You have a `linear_queue` tool for managing Linear notifications that need your attention. The tool is the source of truth — don't parse raw notification messages yourself.

## Tool actions

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
  "event": "issue.assigned",
  "summary": "Issue title or comment text",
  "priority": 1,
  "addedAt": "ISO timestamp"
}
```

## Event types and expected actions

| Event | Priority | Action |
|---|---|---|
| `issue.assigned` | 1 | You've been assigned an issue. Read the issue details with the Linear tools, understand the requirements, and begin work. |
| `issue.reassigned` | 2 | An issue was reassigned away from you. Acknowledge the change, stop any related work, and add a handoff comment if you have useful context. |
| `comment.mention` | 3 | You were mentioned in a comment. Read the comment, understand what's being asked, and respond. |
| `issue.unassigned` | 4 | You were unassigned from an issue. Acknowledge and stop any related work. |

## Processing workflow

1. **Peek** the queue with `linear_queue { action: "peek" }` to see all pending items.
2. **Skip** if there are no items.
3. **Pop** the next item with `linear_queue { action: "pop" }`.
4. **Act**: use the Linear tools (list-issues, update-issue, add-comment) to handle the item per the event type table above.
5. **Repeat** from step 3 until pop returns null.
