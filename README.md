# openclaw-linear

Linear integration for [OpenClaw](https://github.com/nichochar/openclaw). Receives Linear webhook events, records deterministic issue work state in SQLite, dispatches issue-scoped sessions, and gives agents tools to manage issues, comments, projects, teams, and relations via the Linear GraphQL API.

## Install

```bash
openclaw plugins install openclaw-linear
```

## Configuration

Each OpenClaw instance runs one agent — configure a separate instance per agent.

```yaml
plugins:
  linear:
    apiKey: "lin_api_..."                # Linear API key (required)
    webhookSecret: "your-signing-secret" # Webhook secret (required)
    openclawActorId: "linear-user-uuid"  # Optional: OpenClaw actor to ignore for self-echoes
    agentMapping:                        # Filter: only handle events for these Linear users
      "linear-user-uuid": "titus"
    defaultAgentId: "linear-worker"       # Optional: fallback agent for unmapped/unassigned issues
    teamIds: ["ENG", "OPS"]             # Optional: filter to specific teams (empty = all)
    eventFilter: ["Issue", "Comment"]    # Optional: filter event types (empty = all)
    debounceMs: 30000                    # Optional: batch window in ms (default: 30000)
    sqlitePath: "queue/linear.sqlite"     # Optional: relative to OPENCLAW_HOME or ~/.openclaw
    reopenState: "In Progress"           # Optional: state for human comments on completed issues
    completeState: "In Review"           # Optional: state after issue work completes
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
| `apiKey` | string | **Yes** | Linear API key. Create at [linear.app/settings/account/security](https://linear.app/settings/account/security). |
| `webhookSecret` | string | **Yes** | Shared secret for HMAC webhook signature verification. |
| `openclawActorId` | string | No | Linear actor/user ID for the OpenClaw machine account. Comments authored by this actor are normalized as `ignored_self_event` and never enter issue work. Defaults to the local OpenClaw actor ID when omitted. |
| `ignoredActorIds` | string[] | No | Additional Linear actor/user IDs to ignore before routing. |
| `agentMapping` | object | No | Maps Linear user UUIDs to agent IDs. Acts as a filter — events for unmapped users are ignored. Since each instance runs one agent, this typically has one entry. |
| `defaultAgentId` | string | No | Agent ID used for Linear issue creates/comments that do not have a mapped assignee. Default: `main`. |
| `teamIds` | string[] | No | Team keys to scope webhook processing. Empty = all teams. |
| `eventFilter` | string[] | No | Event types to handle (`Issue`, `Comment`). Empty = all. |
| `debounceMs` | integer | No | Debounce window in milliseconds. Events within this window are batched into a single dispatch. Default: `30000` (30s). |
| `sqlitePath` | string | No | SQLite state path. Relative paths resolve under `OPENCLAW_HOME` or `~/.openclaw`. Default: `queue/linear.sqlite`. |
| `reopenState` | string | No | Workflow state used when a human comments on a completed issue. Default: `In Progress`. |
| `completeState` | string | No | Workflow state used after issue work completes with no pending work for the same issue. Default: `In Review`. |
| `stateActions` | object | No | Maps Linear state types or names to issue work actions (`"add"`, `"remove"`, `"ignore"`). See [State Actions](#state-actions). |

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

## How It Works

```text
                         Linear Webhook POST
                                │
                                ▼
                  ┌───────────────────────────┐
                  │      Webhook Handler      │
                  │  HMAC verify · dedup (10m) │
                  └─────────────┬─────────────┘
                                │
                                ▼
                  ┌───────────────────────────┐
                  │       Event Router        │
                  │  team/type filter · user  │
                  │  mapping · state actions  │
                  └──────┬────────────┬───────┘
                         │            │
                     wake         notify
                     actions      actions
                         │            │
                         ▼            │
                  ┌──────────────┐    │
                  │   Debouncer  │    │
                  │  (30s batch) │    │
                  └──────┬───────┘    │
                         │            │
                         ▼            ▼
                  ┌───────────────────────────┐
                  │      IssueWorkStore       │
                  │  SQLite · per-issue state │
                  │  dedup · pending followups│
                  └─────────────┬─────────────┘
                                │
                           added > 0?
                          yes/      \no
                           │         └─▶ (skip)
                           ▼
                  ┌───────────────────────────┐
                  │   IssueWorkDispatcher     │
                  │   claim · build packet    │
                  └─────────────┬─────────────┘
                                │
                                ▼
                  ┌───────────────────────────┐
                  │          Agent            │
                  │ process claimed packet    │
                  └─────────────┬─────────────┘
                                │
                           on complete
                                │
                         items remain?
                          yes/      \no
                           │         └─▶ (idle)
                           ▼
                 dispatcher auto-wake
```

Events flow through four stages. The **webhook handler** verifies signatures and records webhook deliveries. The **normalizer** stores a deterministic decision for each accepted event, ignoring OpenClaw-authored comments before routing. The **event router** filters by team, type, and user, then classifies each event as `wake` (needs the agent's attention now) or `notify` (store silently). Wake actions pass through a **debouncer** that batches events within a configurable window. Actionable events update the **IssueWorkStore**. The **IssueWorkDispatcher** claims dispatchable issue work and wakes the issue-scoped session with a structured packet.

## Issue Work Store

The issue work store is the central data structure. Every webhook event that needs agent attention updates one durable issue row. No LLM tokens are spent on triage; store writes and dispatcher decisions are deterministic.

### Storage

Raw webhook deliveries, normalized decisions, and actionable issue work are persisted to one SQLite database. By default this is `~/.openclaw/queue/linear.sqlite` (`OPENCLAW_HOME/queue/linear.sqlite` when `OPENCLAW_HOME` is set). The canonical table definition lives in `schema.sql`. The issue work store keeps one active work row per Linear issue and records event keys durably so repeated comment events do not create duplicate work.

For a brand-new OpenClaw instance or local setup, initialize the tables with:

```bash
npm run init-db -- /path/to/linear.sqlite
```

If no path is provided, the script initializes `queue/linear.sqlite` under `OPENCLAW_HOME` or `~/.openclaw`.

### Item Lifecycle

```text
  webhook event
       │
       ▼
   ┌────────┐ dispatcher claim ┌─────────────┐ complete/reconcile ┌───────────┐
   │pending │ ─────────────▶ │ in_progress │ ───────────▶ │ in_review │
   └────────┘                └─────────────┘              └───────────┘
       │                            │
       │  removal event             │  lease recovery
       ▼                            ▼
   (removed)                   (→ pending)
```

1. **Record** — webhook deliveries are inserted into `webhook_events`; duplicate delivery IDs are skipped.
2. **Normalize** — webhook events are classified before routing. OpenClaw-authored comments are ignored.
3. **Enqueue** — actionable events update one issue-scoped work row, deduped by durable event key.
4. **Claim** — the dispatcher claims issue-scoped work before waking the session. `linear_queue claim/pop/drain` remain compatibility/debug actions.
5. **Complete** — reconciles the active Codex run, moves finished work to review, blocks failed runs, or promotes stored follow-ups to fresh `pending` work.
6. **Lease recovery** — child Codex runs refresh a 5 minute lease. Startup also recovers unleased records from older versions; periodic recovery only reclaims expired leases whose process record is no longer alive.

### Priority Sorting

Items sort by Linear priority (1 = urgent, 4 = low). Priority 0 (none) maps to 5 so unprioritized items sort last. Ties break by timestamp (oldest first). Priority changes from Linear update items in-place.

### Deduplication

Each event has a durable dedup key of `entryId:queueEvent` (for example, `ENG-42:ticket` or `comment-uuid:mention`). If the same event key has already been recorded, the new event is skipped. If a new human follow-up arrives while the issue is `in_progress`, it is stored as a pending follow-up and promoted after the current work item completes.

### Removal Events

When an issue is unassigned, reassigned away, or moved to a `remove` state, any matching `ticket` item is removed from the queue — even if already `in_progress`. This prevents the agent from working on stale assignments.

### Queue Events

| Agent Event | Queue Event | Behavior |
|---|---|---|
| `issue.assigned` | `ticket` | Enqueue + wake |
| `issue.state_readded` | `ticket` | Enqueue + wake |
| `comment.mention` | `mention` | Enqueue + wake |
| `issue.unassigned` | — | Remove ticket |
| `issue.reassigned` | — | Remove ticket |
| `issue.state_removed` | — | Remove ticket |
| `issue.priority_changed` | — | Update priority in-place |

### Issue Work Tool

Use `linear_issue_work` for normal issue lifecycle operations.

| Action | Description |
|--------|-------------|
| `view` | View one issue work record and recent Codex runs |
| `complete` | Ask the dispatcher to reconcile completed issue work |
| `recover` | Recover expired issue work leases |
| `debug` | Read recent JSONL debug entries by issue, session, or webhook delivery |

### Compatibility Tool

The `linear_queue` tool still exists for compatibility and debugging. New dispatcher packets are already claimed before they reach the session. The `complete` action now delegates to the issue work dispatcher: it checks the active Codex run record, defers if the run is still active, moves finished work to the configured `completeState`, blocks failed runs, or promotes pending follow-up comments back into the owning issue session.

| Action | Description |
|--------|-------------|
| `peek` | View all pending items sorted by priority |
| `claim` | Claim the highest-priority pending item for one issue |
| `pop` | Claim the highest-priority pending item |
| `drain` | Claim all pending items at once |
| `complete` | Ask the dispatcher to reconcile completed issue work (requires `issueId`) |

### Debug Logs

The plugin writes append-only JSONL diagnostics under `OPENCLAW_HOME/state/linear-debug` by default. Entries are grouped by issue, session key, and Linear webhook delivery ID where those identifiers are available.

```bash
npm run debug -- issue EUG-55
npm run debug -- event <linear-delivery-id>
npm run debug -- runs EUG-55
```

## Tools

The plugin provides seven tools. All use an `action` parameter to select the operation.

### `linear_issue` — issue management

| Action | Required | Optional |
|--------|----------|----------|
| `view` | `issueId` | — |
| `list` | — | `state`, `assignee`, `team`, `project`, `limit` |
| `create` | `title` | `description`, `assignee`, `state`, `priority`, `team`, `project`, `parent`, `labels` |
| `update` | `issueId` | `title`, `description`, `assignee`, `state`, `priority`, `labels`, `project` |
| `delete` | `issueId` | — |

Issues are referenced by human-readable identifiers (e.g. `ENG-123`). Names are resolved automatically — `assignee` accepts display names or emails, `state` accepts workflow state names, `team` accepts team keys, and `labels` accepts label names.

### `linear_comment` — comments

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

## Routed Events

| Linear Event | Router Action | Agent Event |
|---|---|---|
| Issue assigned to mapped user | `wake` | `issue.assigned` |
| Issue unassigned from mapped user | `notify` | `issue.unassigned` |
| Issue reassigned away from mapped user | `notify` | `issue.reassigned` |
| Issue state change → `add` action | `wake` | `issue.state_readded` |
| Issue state change → `remove` action | `notify` | `issue.state_removed` |
| @mention in comment (mapped user) | `wake` | `comment.mention` |

`wake` events pass through the debouncer and dispatch to the agent. `notify` events write directly to the queue without waking.

## State Actions

When an issue's state changes, the plugin resolves what to do based on the `stateActions` config. This controls which state transitions re-add issues to the queue (e.g. bounced back from testing) vs. remove them (e.g. done/canceled) vs. are ignored (e.g. in progress).

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

## Architecture

```text
src/
├── index.ts                 # Plugin entry point, activation, dispatch logic
├── webhook-handler.ts       # HMAC verification, body parsing, dedup
├── event-router.ts          # Event filtering, routing, state action resolution
├── linear-api.ts            # GraphQL client, name/ID resolution helpers
├── issue-work-store.ts      # SQLite per-issue work state store
├── issue-work-dispatcher.ts # Deterministic issue work state machine
├── debug-log.ts             # Per-issue/session/event JSONL diagnostics
└── tools/
    ├── issue-work-tool.ts   # linear_issue_work — issue lifecycle/debug
    ├── queue-tool.ts        # linear_queue — compatibility/debug facade
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
