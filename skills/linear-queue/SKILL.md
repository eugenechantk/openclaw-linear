---
name: linear-queue
description: Work queue processing for Linear notifications. Guides the agent through reading, prioritizing, and completing queued Linear items.
metadata: { "openclaw": { "always": true } }
---

# Linear Work Queue

You have a work queue at `queue/work-queue.json` containing Linear notifications that need your attention. The queue is the source of truth — don't parse raw notification messages yourself.

## Queue item structure

```json
{
  "id": "TEAM-123",
  "issueId": "TEAM-123",
  "event": "issue.assigned",
  "summary": "Issue title or comment text",
  "status": "pending",
  "priority": 1,
  "addedAt": "ISO timestamp",
  "startedAt": null,
  "completedAt": null
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

1. **Read** the queue file (`queue/work-queue.json`).
2. **Skip** if there are no `pending` items.
3. **Pick** the highest-priority `pending` item (lowest priority number first; break ties by `addedAt`, oldest first).
4. **Mark `in_progress`**: set `status` to `"in_progress"` and `startedAt` to the current ISO timestamp. Write the queue back to disk.
5. **Act**: use the Linear tools (list-issues, update-issue, add-comment) to handle the item per the event type table above.
6. **Mark `done`**: set `status` to `"done"` and `completedAt` to the current ISO timestamp. Write the queue back to disk.
7. **Repeat** from step 1 until no `pending` items remain.

## File update rules

Always do atomic read-modify-write cycles: read the full file, modify the target item in memory, write the entire file back. Never partially update the file.
