import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { LinearDebugLogger, readDebugLogEntries } from "../src/debug-log.js";

const TMP_DIR = join(import.meta.dirname ?? __dirname, "../.test-tmp-debug-log");

beforeEach(() => {
  mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

describe("LinearDebugLogger", () => {
  it("writes and reads issue debug entries", () => {
    const logger = new LinearDebugLogger(TMP_DIR);

    logger.append({
      type: "dispatcher.dispatched",
      issueId: "EUG-55",
      sessionKey: "agent:main:linear:direct:issue:EUG-55",
      deliveryId: "delivery-1",
      count: 1,
    });

    expect(readDebugLogEntries(TMP_DIR, "issue", "EUG-55")).toMatchObject([
      {
        type: "dispatcher.dispatched",
        issueId: "EUG-55",
        deliveryId: "delivery-1",
        count: 1,
      },
    ]);
    expect(readDebugLogEntries(TMP_DIR, "event", "delivery-1")).toHaveLength(1);
    expect(readDebugLogEntries(TMP_DIR, "session", "agent:main:linear:direct:issue:EUG-55")).toHaveLength(1);
  });
});

