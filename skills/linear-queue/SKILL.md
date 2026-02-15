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

## Processing workflow

1. **Peek** the queue with `linear_queue { action: "peek" }` to see all pending items.
2. **Skip** if there are no items.
3. **Pop** the next item with `linear_queue { action: "pop" }`.
4. **Act**: use the Linear tools (list-issues, update-issue, add-comment) to handle the item per the event type table above.
5. **Repeat** from step 3 until pop returns null.
