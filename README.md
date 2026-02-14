# @openclaw/linear

Linear webhook integration for OpenClaw. Receives Linear events, filters and routes them, and dispatches consolidated notifications to agents.

## Features

- **Webhook handler** — receives Linear webhook events with HMAC signature verification (timing-safe), duplicate delivery detection, and body size limits
- **Event router** — filters by team and event type, routes issue assignments and comment mentions to the configured agent
- **Debounced dispatch** — batches events within a configurable window into a single consolidated message so the agent can triage before acting

## Install

```bash
npm install @openclaw/linear
```

## Configuration

Add the plugin to your OpenClaw config. Each OpenClaw instance runs one agent — configure a separate instance per agent.

```yaml
plugins:
  linear:
    webhookSecret: "your-webhook-signing-secret"
    agentMapping:                     # Filter: only handle events for these Linear users
      "linear-user-uuid": "titus"
    teamIds: ["ENG", "OPS"]          # Optional: filter to specific teams (empty = all)
    eventFilter: ["Issue", "Comment"] # Optional: filter event types (empty = all)
    debounceMs: 30000                 # Optional: batch window in ms (default: 30000)
```

### Config Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `webhookSecret` | string | **Yes** | Shared secret for HMAC webhook signature verification. |
| `agentMapping` | object | No | Maps Linear user UUIDs to agent IDs. Acts as a filter — events for unmapped users are ignored. Since each instance runs one agent, this typically has one entry. |
| `teamIds` | string[] | No | Team keys to scope webhook processing. Empty = all teams. |
| `eventFilter` | string[] | No | Event types to handle (`Issue`, `Comment`). Empty = all. |
| `debounceMs` | integer | No | Debounce window in milliseconds. Events arriving within this window are batched into a single message. Must be positive. Default: `30000` (30s). |

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
| @mention in comment (mapped user) | `wake` | `comment.mention` |

`wake` events are enqueued into the debouncer and dispatched to the agent. `notify` events are logged only.

## How Dispatch Works

```text
Linear webhook POST
  → HMAC signature verified (timing-safe)
  → Duplicate delivery check (10-min TTL, 10k cap)
  → Event router filters by team/type, matches user via agentMapping
  → wake actions enqueued into debouncer (keyed by agent ID)
  → After debounce window expires, consolidated message dispatched to agent
```

When multiple events arrive within the debounce window, the agent receives a single numbered message:

```
You have 3 new Linear notifications:

1. [Assigned] ENG-42: Fix login bug
2. [Assigned] ENG-43: Update API docs
3. [Mentioned] ENG-40: Auth flow: "Can you review this?"

Review and prioritize before starting work.
```

Single events are passed through as-is (no numbered wrapper).

## Development

```bash
npm install
npm run build

# Type-check without emitting
npx tsc --noEmit

# Run tests
npm test
```
