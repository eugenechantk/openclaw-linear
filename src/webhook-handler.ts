import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { WebhookEventStore } from "./webhook-event-store.js";

export type LinearWebhookPayload = {
  action: string;
  type: string;
  data: Record<string, unknown>;
  updatedFrom?: Record<string, unknown>;
  createdAt: string;
  deliveryId?: string;
};

type WebhookHandlerDeps = {
  webhookSecret: string | string[];
  logger: {
    info: (message: string) => void;
    error: (message: string) => void;
  };
  eventStore?: WebhookEventStore;
  onEvent?: (event: LinearWebhookPayload) => void | Promise<void>;
};

const MAX_BODY_BYTES = 1024 * 1024; // 1 MB

function verifySignature(body: string, signature: string, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  if (expected.length !== signature.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function createWebhookHandler(deps: WebhookHandlerDeps) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" });
      res.end("Method Not Allowed");
      return;
    }

    let rawBody: string;
    try {
      rawBody = await readBody(req);
    } catch (err) {
      const msg = formatErrorMessage(err);
      if (msg.includes("too large")) {
        res.writeHead(413);
        res.end("Payload Too Large");
      } else {
        res.writeHead(500);
        res.end("Internal Server Error");
      }
      return;
    }

    const signature = req.headers["linear-signature"];
    const secrets = Array.isArray(deps.webhookSecret) ? deps.webhookSecret : [deps.webhookSecret];
    const signatureValid = typeof signature === "string" && secrets.some((s) => verifySignature(rawBody, signature, s));
    if (!signatureValid) {
      res.writeHead(400);
      res.end("Invalid signature");
      return;
    }

    let event: LinearWebhookPayload;
    try {
      const payload = JSON.parse(rawBody) as Record<string, unknown>;
      const deliveryId = req.headers["linear-delivery"] as string | undefined;
      const data = (payload.data as Record<string, unknown>) ?? payload;

      if (deliveryId && deps.eventStore) {
        const issue = data.issue as Record<string, unknown> | undefined;
        const user = data.user as Record<string, unknown> | undefined;
        const inserted = deps.eventStore.insert({
          deliveryId,
          action: String(payload.action ?? ""),
          type: String(payload.type ?? ""),
          issueId: String(issue?.id ?? data.issueId ?? data.id ?? ""),
          commentId: String(payload.type ?? "") === "Comment" ? String(data.id ?? "") : undefined,
          actorId: (user?.id as string | undefined) ?? (data.userId as string | undefined),
          createdAt: String(payload.createdAt ?? ""),
          rawBody,
        });
        if (!inserted.inserted) {
          deps.logger.info(`Duplicate delivery skipped: ${deliveryId}`);
          res.writeHead(200);
          res.end("OK");
          return;
        }
      }

      event = {
        action: String(payload.action ?? ""),
        type: String(payload.type ?? ""),
        // Some Linear webhook payloads (e.g. OAuth App events) place fields
        // directly on the top-level object instead of nesting under `data`.
        // Fall back to the full payload so downstream handlers still see data.
        data,
        updatedFrom: (payload.updatedFrom as Record<string, unknown>) ?? undefined,
        createdAt: String(payload.createdAt ?? ""),
        deliveryId,
      };

      deps.logger.info(`Linear webhook: ${event.action} ${event.type} (${String(event.data.id ?? "unknown")})`);
    } catch (err) {
      deps.logger.error(`Webhook parse error: ${formatErrorMessage(err)}`);
      res.writeHead(500);
      res.end("Internal Server Error");
      return;
    }

    // Always return 200 after successful parse — onEvent errors must not
    // cause Linear to retry (which could create a retry storm).
    res.writeHead(200);
    res.end("OK");

    try {
      await deps.onEvent?.(event);
    } catch (err) {
      deps.logger.error(`Event handler error: ${formatErrorMessage(err)}`);
    }
  };
}
