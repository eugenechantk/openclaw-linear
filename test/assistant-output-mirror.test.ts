import { describe, it, expect, vi } from "vitest";
import {
  LinearAssistantOutputMirror,
  issueIdentifierFromSessionKey,
  shouldMirrorAssistantText,
  splitLinearCommentBody,
} from "../src/assistant-output-mirror.js";

const logger = {
  info: vi.fn(),
  error: vi.fn(),
};

describe("issueIdentifierFromSessionKey", () => {
  it("extracts the Linear issue identifier from issue-scoped sessions", () => {
    expect(issueIdentifierFromSessionKey("agent:main:linear:direct:issue:eug-57")).toBe("EUG-57");
  });

  it("ignores non-Linear issue sessions", () => {
    expect(issueIdentifierFromSessionKey("agent:main:slack:direct:issue:eug-57")).toBeUndefined();
    expect(issueIdentifierFromSessionKey("agent:main:linear:direct:queue-wake-1")).toBeUndefined();
  });
});

describe("shouldMirrorAssistantText", () => {
  it("ignores empty and NO_REPLY outputs", () => {
    expect(shouldMirrorAssistantText("")).toBe(false);
    expect(shouldMirrorAssistantText("  \n")).toBe(false);
    expect(shouldMirrorAssistantText("NO_REPLY")).toBe(false);
    expect(shouldMirrorAssistantText("no_reply")).toBe(false);
  });

  it("allows visible text", () => {
    expect(shouldMirrorAssistantText("I made the change.")).toBe(true);
  });
});

describe("splitLinearCommentBody", () => {
  it("splits long comments on paragraph boundaries when possible", () => {
    const chunks = splitLinearCommentBody("First paragraph.\n\nSecond paragraph.", 20);
    expect(chunks).toEqual(["First paragraph.", "Second paragraph."]);
  });

  it("hard-splits when no newline boundary is available", () => {
    const chunks = splitLinearCommentBody("abcdefghij", 4);
    expect(chunks).toEqual(["abcd", "efgh", "ij"]);
  });
});

describe("LinearAssistantOutputMirror", () => {
  it("buffers assistant deltas and posts once on lifecycle end", async () => {
    const postComment = vi.fn().mockResolvedValue(undefined);
    const mirror = new LinearAssistantOutputMirror({ postComment, logger });

    await mirror.handleAgentEvent({
      runId: "run-1",
      stream: "assistant",
      sessionKey: "agent:main:linear:direct:issue:eug-57",
      data: { text: "Hello", delta: "Hello" },
    });
    await mirror.handleAgentEvent({
      runId: "run-1",
      stream: "assistant",
      sessionKey: "agent:main:linear:direct:issue:eug-57",
      data: { text: "Hello world", delta: " world" },
    });
    await mirror.handleAgentEvent({
      runId: "run-1",
      stream: "lifecycle",
      sessionKey: "agent:main:linear:direct:issue:eug-57",
      data: { phase: "end" },
    });

    expect(postComment).toHaveBeenCalledWith("EUG-57", "Hello world");
  });

  it("handles replacement assistant updates without duplicating text", async () => {
    const postComment = vi.fn().mockResolvedValue(undefined);
    const mirror = new LinearAssistantOutputMirror({ postComment, logger });

    await mirror.handleAgentEvent({
      runId: "run-1",
      stream: "assistant",
      sessionKey: "agent:main:linear:direct:issue:eug-57",
      data: { text: "Draft answer", delta: "Draft answer" },
    });
    await mirror.handleAgentEvent({
      runId: "run-1",
      stream: "assistant",
      sessionKey: "agent:main:linear:direct:issue:eug-57",
      data: { text: "Final answer", replace: true },
    });
    await mirror.handleAgentEvent({
      runId: "run-1",
      stream: "lifecycle",
      data: { phase: "end" },
    });

    expect(postComment).toHaveBeenCalledTimes(1);
    expect(postComment).toHaveBeenCalledWith("EUG-57", "Final answer");
  });

  it("ignores assistant output outside Linear issue sessions", async () => {
    const postComment = vi.fn().mockResolvedValue(undefined);
    const mirror = new LinearAssistantOutputMirror({ postComment, logger });

    await mirror.handleAgentEvent({
      runId: "run-1",
      stream: "assistant",
      sessionKey: "agent:main:linear:direct:queue-wake-1",
      data: { text: "Hello", delta: "Hello" },
    });
    await mirror.handleAgentEvent({
      runId: "run-1",
      stream: "lifecycle",
      data: { phase: "end" },
    });

    expect(postComment).not.toHaveBeenCalled();
  });

  it("splits long mirrored output into multiple comments", async () => {
    const postComment = vi.fn().mockResolvedValue(undefined);
    const mirror = new LinearAssistantOutputMirror({ postComment, logger, maxCommentChars: 5 });

    await mirror.handleAgentEvent({
      runId: "run-1",
      stream: "assistant",
      sessionKey: "agent:main:linear:direct:issue:eug-57",
      data: { text: "abcdefghij", delta: "abcdefghij" },
    });
    await mirror.handleAgentEvent({
      runId: "run-1",
      stream: "lifecycle",
      data: { phase: "end" },
    });

    expect(postComment).toHaveBeenNthCalledWith(1, "EUG-57", "abcde");
    expect(postComment).toHaveBeenNthCalledWith(2, "EUG-57", "fghij");
  });

  it("suppresses exact duplicate visible output for the same issue", async () => {
    const postComment = vi.fn().mockResolvedValue(undefined);
    const mirror = new LinearAssistantOutputMirror({ postComment, logger });

    for (const runId of ["run-1", "run-2"]) {
      await mirror.handleAgentEvent({
        runId,
        stream: "assistant",
        sessionKey: "agent:main:linear:direct:issue:eug-57",
        data: { text: "Same output", delta: "Same output" },
      });
      await mirror.handleAgentEvent({
        runId,
        stream: "lifecycle",
        data: { phase: "end" },
      });
    }

    expect(postComment).toHaveBeenCalledTimes(1);
  });

  it("dedupes dispatcher-mirrored text against later agent event text", async () => {
    const postComment = vi.fn().mockResolvedValue(undefined);
    const mirror = new LinearAssistantOutputMirror({ postComment, logger });

    await mirror.mirrorText("EUG-57", "Visible reply");
    await mirror.handleAgentEvent({
      runId: "run-1",
      stream: "assistant",
      sessionKey: "agent:main:linear:direct:issue:eug-57",
      data: { text: "Visible reply", delta: "Visible reply" },
    });
    await mirror.handleAgentEvent({
      runId: "run-1",
      stream: "lifecycle",
      data: { phase: "end" },
    });

    expect(postComment).toHaveBeenCalledTimes(1);
    expect(postComment).toHaveBeenCalledWith("EUG-57", "Visible reply");
  });
});
