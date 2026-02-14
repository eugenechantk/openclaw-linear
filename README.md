# @openclaw/linear

Linear webhook integration for OpenClaw. Receives Linear events and routes them to agents as consolidated notifications.

## Features

- **Webhook handler** — receives Linear webhook events with HMAC signature verification
- **Event router** — routes issue assignments and comment mentions to the right agent
- **Debounced dispatch** — batches rapid-fire events into a single consolidated message
- **Push notifications** — replaces heartbeat polling with real-time webhook delivery

## Install

```bash
npm install @openclaw/linear
```

## Configuration

Add the plugin to your OpenClaw config:

```yaml
plugins:
  linear:
    webhookSecret: "your-webhook-signing-secret"
    teamIds: ["ENG", "OPS"]          # Optional: filter to specific teams (empty = all)
    eventFilter: ["Issue", "Comment"] # Optional: filter event types (empty = all)
    agentMapping:                     # Map Linear user IDs → OpenClaw agent IDs
      "linear-user-uuid-1": "titus"
      "linear-user-uuid-2": "scout"
    debounceMs: 30000                 # Optional: batch window for webhook events (default: 30000)
```

### Config Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `webhookSecret` | string | **Yes** | Shared secret for HMAC webhook signature verification. |
| `teamIds` | string[] | No | Team keys to scope webhook processing. Empty array = all teams. |
| `eventFilter` | string[] | No | Event types to handle (`Issue`, `Comment`, etc.). Empty = all. |
| `agentMapping` | object | No | Maps Linear user UUIDs to OpenClaw agent IDs for notification routing. |
| `debounceMs` | integer | No | Debounce window in milliseconds for batching webhook events before dispatch. When multiple events arrive within this window, they are consolidated into a single message so the agent can triage before acting. Default: `30000` (30s). |

## Webhook Setup

1. **Make your endpoint publicly accessible.** The plugin listens at `/hooks/linear`. Use Tailscale Funnel, ngrok, or a public server:
   ```bash
   # Example with Tailscale Funnel
   tailscale funnel --bg 3000
   ```

2. **Register the webhook in Linear:**
   - Go to **Settings > API > Webhooks** in your Linear workspace
   - Click **New webhook**
   - Set the URL to `https://your-host/hooks/linear`
   - Set the secret to match your `webhookSecret` config value
   - Select the event types you want (Issues, Comments, etc.)
   - Save

3. **Verify it works:** Assign a Linear issue to a mapped user — the corresponding agent should receive a wake event.

## Routed Events

| Linear Event | Router Action | Agent Event |
|---|---|---|
| Issue assigned to mapped user | `wake` | `issue.assigned` |
| Issue unassigned from mapped user | `notify` | `issue.unassigned` |
| Issue reassigned away from mapped user | `notify` | `issue.reassigned` |
| @mention in comment (mapped user) | `wake` | `comment.mention` |

`wake` dispatches the event to the agent through the OpenClaw channel system. `notify` logs the event (passive notification).

When an agent replies to a `wake` event, the reply is posted back as a comment on the Linear issue.

## End-to-End Flow

```text
Linear ticket assigned → Linear sends webhook POST
  → Plugin verifies HMAC signature
  → Event router matches assignee to agent via agentMapping
  → Agent receives wake event with issue context
  → Agent processes and replies → reply posted as Linear comment
```

## Development

```bash
npm install
npm run build

# Type-check without emitting
npx tsc --noEmit

# Run tests
npm test
```
