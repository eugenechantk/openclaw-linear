import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { createWebhookHandler } from "../src/webhook-handler.js";
import type { IncomingMessage, ServerResponse } from "node:http";

const SECRET = "test-webhook-secret";

function makeLogger() {
  return { info: vi.fn(), error: vi.fn() };
}

function sign(body: string): string {
  return createHmac("sha256", SECRET).update(body).digest("hex");
}

function makeReq(
  body: string,
  headers: Record<string, string> = {},
  method = "POST",
): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage;
  req.method = method;
  req.headers = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  // Emit body asynchronously
  process.nextTick(() => {
    req.emit("data", Buffer.from(body));
    req.emit("end");
  });
  return req;
}

function makeRes(): ServerResponse & { body: string; statusCode: number } {
  const res = {
    statusCode: 200,
    body: "",
    writeHead(code: number) {
      res.statusCode = code;
    },
    end(data?: string) {
      res.body = data ?? "";
    },
  } as unknown as ServerResponse & { body: string; statusCode: number };
  return res;
}

describe("webhook-handler", () => {
  let logger: ReturnType<typeof makeLogger>;
  let handler: ReturnType<typeof createWebhookHandler>;

  beforeEach(() => {
    logger = makeLogger();
    handler = createWebhookHandler({ webhookSecret: SECRET, logger });
  });

  it("returns 200 for valid signature", async () => {
    const body = JSON.stringify({
      action: "create",
      type: "Issue",
      data: { id: "issue-1", title: "Test" },
      createdAt: "2026-01-01T00:00:00Z",
    });
    const req = makeReq(body, { "Linear-Signature": sign(body) });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("OK");
    expect(logger.info).toHaveBeenCalledWith(
      "Linear webhook: create Issue (issue-1)",
    );
  });

  it("returns 400 for invalid signature", async () => {
    const body = JSON.stringify({ action: "update", type: "Issue", data: {}, createdAt: "" });
    const req = makeReq(body, { "Linear-Signature": "invalidsignature" });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toBe("Invalid signature");
  });

  it("returns 400 when signature header is missing", async () => {
    const body = JSON.stringify({ action: "update", type: "Issue", data: {}, createdAt: "" });
    const req = makeReq(body, {});
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it("detects and skips duplicate deliveries", async () => {
    const body = JSON.stringify({
      action: "update",
      type: "Issue",
      data: { id: "issue-2" },
      createdAt: "2026-01-01T00:00:00Z",
    });
    const headers = {
      "Linear-Signature": sign(body),
      "Linear-Delivery": "delivery-dup-test-123",
    };

    // First request
    const req1 = makeReq(body, headers);
    const res1 = makeRes();
    await handler(req1, res1);
    expect(res1.statusCode).toBe(200);

    // Second request with same delivery ID
    const req2 = makeReq(body, headers);
    const res2 = makeRes();
    await handler(req2, res2);
    expect(res2.statusCode).toBe(200);
    expect(logger.info).toHaveBeenCalledWith(
      "Duplicate delivery skipped: delivery-dup-test-123",
    );
  });

  it("returns 500 for malformed JSON payload", async () => {
    const body = "not valid json {{{";
    const req = makeReq(body, { "Linear-Signature": sign(body) });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(500);
    expect(logger.error).toHaveBeenCalled();
  });

  it("returns 405 for non-POST methods", async () => {
    const req = makeReq("", {}, "GET");
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });

  it("returns 200 even when onEvent throws", async () => {
    const onEvent = vi.fn(() => {
      throw new Error("handler boom");
    });
    const h = createWebhookHandler({ webhookSecret: SECRET, logger, onEvent });

    const body = JSON.stringify({
      action: "update",
      type: "Issue",
      data: { id: "issue-err" },
      createdAt: "2026-01-01T00:00:00Z",
    });
    const req = makeReq(body, { "Linear-Signature": sign(body) });
    const res = makeRes();
    await h(req, res);

    // Handler returns 200 despite onEvent throwing
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("OK");
    expect(onEvent).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      "Event handler error: handler boom",
    );
  });

  it("captures updatedFrom and passes to onEvent", async () => {
    const onEvent = vi.fn();
    const h = createWebhookHandler({ webhookSecret: SECRET, logger, onEvent });

    const body = JSON.stringify({
      action: "update",
      type: "Issue",
      data: { id: "issue-uf", assigneeId: "user-1" },
      updatedFrom: { assigneeId: null, priority: 3 },
      createdAt: "2026-01-01T00:00:00Z",
    });
    const req = makeReq(body, { "Linear-Signature": sign(body) });
    const res = makeRes();
    await h(req, res);

    expect(res.statusCode).toBe(200);
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        updatedFrom: { assigneeId: null, priority: 3 },
        data: expect.objectContaining({ assigneeId: "user-1" }),
      }),
    );
  });

  it("sets updatedFrom to undefined when absent from payload", async () => {
    const onEvent = vi.fn();
    const h = createWebhookHandler({ webhookSecret: SECRET, logger, onEvent });

    const body = JSON.stringify({
      action: "create",
      type: "Issue",
      data: { id: "issue-no-uf" },
      createdAt: "2026-01-01T00:00:00Z",
    });
    const req = makeReq(body, { "Linear-Signature": sign(body) });
    const res = makeRes();
    await h(req, res);

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ updatedFrom: undefined }),
    );
  });

  it("returns 413 for oversized request body", async () => {
    const req = new EventEmitter() as IncomingMessage;
    req.method = "POST";
    req.headers = {};
    const destroy = vi.fn();
    (req as any).destroy = destroy;

    const res = makeRes();

    // Send 2MB payload in chunks
    process.nextTick(() => {
      const chunk = Buffer.alloc(1024 * 1024 + 1, "x");
      req.emit("data", chunk);
    });

    await handler(req, res);
    expect(res.statusCode).toBe(413);
    expect(res.body).toBe("Payload Too Large");
  });
});
