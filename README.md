# openclaw-linear

Linear integration for [OpenClaw](https://github.com/nichochar/openclaw). Receives Linear webhook events, routes them to agents, and provides tools for managing issues, comments, projects, teams, and relations via the Linear GraphQL API.

## Features

- **Webhook handler** — receives Linear webhook events with HMAC signature verification (timing-safe), duplicate delivery detection, and body size limits
- **Event router** — filters by team and event type, routes issue assignments and comment mentions to the configured agent
- **Debounced dispatch** — batches events within a configurable window before dispatching
- **Work queue** — deterministic queue writes structured items with priority sorting, deduplication, and 24h auto-cleanup — no LLM tokens spent on triage
- **Crash recovery** — resets stale `in_progress` queue items to `pending` on startup
- **Direct API integration** — all tools call the Linear GraphQL API directly, no external CLI binary required

## Install

```bash
openclaw plugins install openclaw-linear
```

## Configuration

Add the plugin to your OpenClaw config. Each OpenClaw instance runs one agent — configure a separate instance per agent.

```yaml
plugins:
  linear:
    apiKey: "lin_api_..."                # Linear API key (required)
    webhookSecret: "your-signing-secret" # Webhook secret (required)
    agentMapping:                        # Filter: only handle events for these Linear users
      "linear-user-uuid": "titus"
    teamIds: ["ENG", "OPS"]             # Optional: filter to specific teams (empty = all)
    eventFilter: ["Issue", "Comment"]    # Optional: filter event types (empty = all)
    debounceMs: 30000                    # Optional: batch window in ms (default: 30000)
    stateActions:                        # Optional: map state types/names to queue actions
      backlog: "add"
      unstarted: "add"
      started: "ignore"
      "In Review": "remove"             # State names override type matches (case-insensitive)
      completed: "remove"
      canceled: "remove"
```

### Config Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `apiKey` | string | **Yes** | Linear API key for authentication. Create one at [linear.app/settings/account/security](https://linear.app/settings/account/security). |
| `webhookSecret` | string | **Yes** | Shared secret for HMAC webhook signature verification. |
| `agentMapping` | object | No | Maps Linear user UUIDs to agent IDs. Acts as a filter — events for unmapped users are ignored. Since each instance runs one agent, this typically has one entry. |
| `teamIds` | string[] | No | Team keys to scope webhook processing. Empty = all teams. |
| `eventFilter` | string[] | No | Event types to handle (`Issue`, `Comment`). Empty = all. |
| `debounceMs` | integer | No | Debounce window in milliseconds. Events arriving within this window are batched into a single dispatch. Default: `30000` (30s). |
| `stateActions` | object | No | Maps Linear state types or names to queue actions (`"add"`, `"remove"`, `"ignore"`). See [State Actions](#state-actions). |

## Tools

The plugin provides six tools that agents can use to interact with Linear. All tools use an `action` parameter to select the operation.

### `linear_queue` — notification inbox

Manage the queue of webhook-driven notifications.

| Action | Description |
|--------|-------------|
| `peek` | View all pending items sorted by priority |
| `pop` | Claim the highest-priority pending item |
| `drain` | Claim all pending items |
| `complete` | Finish work on a claimed item (requires `issueId`) |

### `linear_issue` — issue management

View, search, create, update, and delete Linear issues.

| Action | Required | Optional |
|--------|----------|----------|
| `view` | `issueId` | — |
| `list` | — | `state`, `assignee`, `team`, `project`, `limit` |
| `create` | `title` | `description`, `assignee`, `state`, `priority`, `team`, `project`, `parent`, `labels` |
| `update` | `issueId` | `title`, `description`, `assignee`, `state`, `priority`, `labels`, `project` |
| `delete` | `issueId` | — |

Issues are referenced by human-readable identifiers (e.g. `ENG-123`). Names are resolved automatically — `assignee` accepts display names or emails, `state` accepts workflow state names, `team` accepts team keys, and `labels` accepts label names.

### `linear_comment` — comments

Read, create, and update comments on issues.

| Action | Required | Optional |
|--------|----------|----------|
| `list` | `issueId` | — |
| `add` | `issueId`, `body` | `parentCommentId` |
| `update` | `commentId`, `body` | — |

### `linear_team` — teams and members

| Action | Required |
|--------|----------|
| `list` | — |
| `members` | `team` (key, e.g. `ENG`) |

### `linear_project` — projects

| Action | Required | Optional |
|--------|----------|----------|
| `list` | — | `team`, `status` |
| `view` | `projectId` | — |
| `create` | `name` | `team`, `description` |

### `linear_relation` — issue relations

| Action | Required |
|--------|----------|
| `list` | `issueId` |
| `add` | `issueId`, `type`, `relatedIssueId` |
| `delete` | `relationId` |

Relation types: `blocks`, `blocked-by`, `related`, `duplicate`.

## Webhook Setup

1. **Make your endpoint publicly accessible.** The plugin registers at `/hooks/linear`:
   ```bash
   # Example with Tailscale Funnel
   tailscale funnel --bg 3000
   ```

2. **Register the webhook in Linear:**
   - Go to **Settings > API > Webhooks**
   - Set the URL to `https://your-host/hooks/linear`
   - Set the secret to match your `webhookSecret`
   - Select event types: Issues, Comments
   - Save

3. **Verify:** Assign a Linear issue to a mapped user — the agent should receive a notification.

## Routed Events

| Linear Event | Router Action | Agent Event |
|---|---|---|
| Issue assigned to mapped user | `wake` | `issue.assigned` |
| Issue unassigned from mapped user | `notify` | `issue.unassigned` |
| Issue reassigned away from mapped user | `notify` | `issue.reassigned` |
| Issue state change → `add` action | `wake` | `issue.state_readded` |
| Issue state change → `remove` action | `notify` | `issue.state_removed` |
| @mention in comment (mapped user) | `wake` | `comment.mention` |

`wake` events are enqueued into the debouncer and dispatched to the agent. `notify` events write to the queue without waking.

## State Actions

When an issue's state changes, the plugin resolves what to do based on the `stateActions` config. This lets you control which state transitions re-add issues to the queue (e.g. bounced back from testing) vs. remove them (e.g. done/canceled) vs. are ignored (e.g. in progress).

**Resolution order:** state name match → state type match → built-in default.

Linear has 6 fixed state types. Custom state names (e.g. "In Review", "QA") are team-specific but always belong to one of these types.

**Built-in defaults** (used when `stateActions` is not configured or a state isn't mapped):

| State Type | Default Action |
|---|---|
| `triage` | `ignore` |
| `backlog` | `add` |
| `unstarted` | `add` |
| `started` | `ignore` |
| `completed` | `remove` |
| `canceled` | `remove` |

**Actions:**

- `"add"` — re-add the issue to the queue as a ticket and wake the agent
- `"remove"` — remove the issue's ticket from the queue
- `"ignore"` — do nothing (default for unmapped states)

## How Dispatch Works

```text
Linear webhook POST
  → HMAC signature verified (timing-safe)
  → Duplicate delivery check (10-min TTL, 10k cap)
  → Event router filters by team/type, matches user via agentMapping
  → wake actions enqueued into debouncer (keyed by agent ID)
  → After debounce window expires:
      → Notifications written to queue (deterministic, no LLM)
      → Deduped against existing non-done items — skips dispatch if nothing new
      → Agent receives: "3 new Linear notification(s) queued."
      → After agent completes an item, auto-wake continues if items remain
```

## Architecture

```text
src/
├── index.ts                 # Plugin entry point, activation, dispatch logic
├── webhook-handler.ts       # HMAC verification, body parsing, dedup
├── event-router.ts          # Event filtering, routing, state action resolution
├── linear-api.ts            # GraphQL client, name/ID resolution helpers
├── work-queue.ts            # Persistent JSONL queue with priority sorting
└── tools/
    ├── queue-tool.ts        # linear_queue — notification inbox management
    ├── linear-issue-tool.ts # linear_issue — CRUD for issues
    ├── linear-comment-tool.ts # linear_comment — issue comments
    ├── linear-team-tool.ts  # linear_team — teams and members
    ├── linear-project-tool.ts # linear_project — project management
    └── linear-relation-tool.ts # linear_relation — issue relations
```

## Development

```bash
npm install
npm run build
npm test
```
