import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { NormalizedEvent } from "./event-normalizer.js";
import { initializeLinearSchema } from "./schema.js";

export type WebhookEventRecord = {
  deliveryId: string;
  action: string;
  type: string;
  issueId?: string;
  commentId?: string;
  actorId?: string;
  createdAt?: string;
  receivedAt: string;
  rawBody: string;
};

export type WebhookEventInsertResult =
  | { inserted: true }
  | { inserted: false; reason: "duplicate_delivery" };

export type NormalizedEventRecord = {
  deliveryId?: string;
  issueId?: string;
  identifier?: string;
  commentId?: string;
  actorId?: string;
  intent: string;
  decision: "process" | "ignore";
  reason?: string;
  createdAt?: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

export class WebhookEventStore {
  private readonly db: DatabaseSync;

  constructor(private readonly path: string) {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(path);
    this.initialize();
  }

  private initialize(): void {
    initializeLinearSchema(this.db);
  }

  insert(record: Omit<WebhookEventRecord, "receivedAt"> & { receivedAt?: string }): WebhookEventInsertResult {
    const result = this.db
      .prepare(`
        INSERT OR IGNORE INTO webhook_events (
          delivery_id, action, type, issue_id, comment_id, actor_id,
          created_at, received_at, raw_body
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        record.deliveryId,
        record.action,
        record.type,
        record.issueId ?? null,
        record.commentId ?? null,
        record.actorId ?? null,
        record.createdAt ?? null,
        record.receivedAt ?? nowIso(),
        record.rawBody,
      );

    return Number(result.changes) > 0
      ? { inserted: true }
      : { inserted: false, reason: "duplicate_delivery" };
  }

  has(deliveryId: string): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM webhook_events WHERE delivery_id = ?")
      .get(deliveryId);
    return Boolean(row);
  }

  recordNormalizedEvent(record: NormalizedEventRecord): void {
    this.db
      .prepare(`
        INSERT INTO normalized_events (
          delivery_id, issue_id, identifier, comment_id, actor_id,
          intent, decision, reason, created_at, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        record.deliveryId ?? null,
        record.issueId ?? null,
        record.identifier ?? null,
        record.commentId ?? null,
        record.actorId ?? null,
        record.intent,
        record.decision,
        record.reason ?? null,
        record.createdAt ?? null,
        nowIso(),
      );
  }

  recordNormalizedDecision(event: NormalizedEvent, createdAt?: string): void {
    this.recordNormalizedEvent({
      deliveryId: event.deliveryId,
      issueId: event.issueId,
      identifier: event.identifier,
      commentId: event.commentId,
      actorId: event.actorId,
      intent: event.intent,
      decision: event.action === "process" ? "process" : "ignore",
      reason: event.action === "ignore" ? event.reason : undefined,
      createdAt,
    });
  }

  listNormalizedEvents(): NormalizedEventRecord[] {
    return this.db
      .prepare(`
        SELECT
          delivery_id as deliveryId,
          issue_id as issueId,
          identifier,
          comment_id as commentId,
          actor_id as actorId,
          intent,
          decision,
          reason,
          created_at as createdAt
        FROM normalized_events
        ORDER BY id ASC
      `)
      .all() as NormalizedEventRecord[];
  }
}
