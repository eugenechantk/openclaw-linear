# Changelog

## [0.4.0] — 2026-02-14

### Added

- **Configurable state change actions** — new `stateActions` config maps Linear state types or names to queue actions (`add`, `remove`, `ignore`). Issues bouncing back to backlog/todo re-enter the queue; in-progress is ignored; done/canceled trigger removal. State name matches take precedence over type matches (case-insensitive), with sensible built-in defaults.
- **Issue priority for queue ordering** — queue items are now sorted by Linear issue priority.

### Changed

- Simplified queue to 2 event types: `ticket` and `mention`.
- Use Linear `updatedFrom` field for reliable detection of assignment, state, and priority changes.
- State change events are now `issue.state_removed` / `issue.state_readded` instead of `issue.completed` / `issue.canceled`.

### Removed

- Dead `parseNotificationMessage` code.

## [0.3.0] — 2026-02-14

### Changed

- Replaced shared queue JSON file with tool-based `InboxQueue` using mutex for safe concurrent access.

## [0.2.0] — 2026-02-14

### Added

- `linear-queue` skill for work queue processing.
- Queue intake and crash recovery integrated into the plugin lifecycle.

### Removed

- Standalone queue hooks (replaced by integrated intake/recovery).

## [0.1.0] — 2026-02-13

Initial release.

### Added

- Webhook handler with HMAC signature verification (timing-safe), duplicate delivery detection, and body size limits.
- Event router with team and event type filtering, issue assignment and comment mention routing.
- Debounced dispatch — batches events within a configurable window before dispatching to agents.
- Plugin configuration: `webhookSecret`, `agentMapping`, `teamIds`, `eventFilter`, `debounceMs`.
