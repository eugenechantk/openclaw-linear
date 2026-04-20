const LINEAR_ISSUE_SESSION_PATTERN = /^agent:[^:]+:linear:direct:issue:([a-z]+-\d+)$/i;
const DEFAULT_MAX_COMMENT_CHARS = 8_000;

export interface AssistantMirrorAgentEvent {
  runId: string;
  stream: string;
  sessionKey?: string;
  data?: Record<string, unknown>;
}

export interface AssistantOutputMirrorLogger {
  info(message: string): void;
  error(message: string): void;
}

export interface AssistantOutputMirrorOptions {
  postComment: (issueIdentifier: string, body: string) => Promise<boolean | void>;
  logger: AssistantOutputMirrorLogger;
  maxCommentChars?: number;
}

interface BufferedRun {
  issueIdentifier: string;
  text: string;
}

export function issueIdentifierFromSessionKey(sessionKey: string | undefined): string | undefined {
  if (!sessionKey) return undefined;
  const match = sessionKey.match(LINEAR_ISSUE_SESSION_PATTERN);
  return match ? match[1].toUpperCase() : undefined;
}

export function splitLinearCommentBody(body: string, maxChars = DEFAULT_MAX_COMMENT_CHARS): string[] {
  if (body.length <= maxChars) return [body];

  const chunks: string[] = [];
  let remaining = body;

  while (remaining.length > maxChars) {
    let splitAt = remaining.lastIndexOf("\n\n", maxChars);
    if (splitAt < Math.floor(maxChars / 2)) splitAt = remaining.lastIndexOf("\n", maxChars);
    if (splitAt < Math.floor(maxChars / 2)) splitAt = maxChars;

    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

export function shouldMirrorAssistantText(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  return normalized.toUpperCase() !== "NO_REPLY";
}

export class LinearAssistantOutputMirror {
  private readonly buffersByRunId = new Map<string, BufferedRun>();
  private readonly postedHashesByIssue = new Map<string, Set<string>>();
  private readonly postComment: (issueIdentifier: string, body: string) => Promise<boolean | void>;
  private readonly logger: AssistantOutputMirrorLogger;
  private readonly maxCommentChars: number;

  constructor(options: AssistantOutputMirrorOptions) {
    this.postComment = options.postComment;
    this.logger = options.logger;
    this.maxCommentChars = options.maxCommentChars ?? DEFAULT_MAX_COMMENT_CHARS;
  }

  async handleAgentEvent(event: AssistantMirrorAgentEvent): Promise<void> {
    if (event.stream === "assistant") {
      this.handleAssistantEvent(event);
      return;
    }

    if (event.stream === "lifecycle" && isTerminalLifecycleEvent(event)) {
      await this.flushRun(event.runId);
    }
  }

  async mirrorText(issueIdentifier: string, text: string): Promise<void> {
    const body = text.trim();
    if (!shouldMirrorAssistantText(body)) return;

    const normalizedIssueIdentifier = issueIdentifier.toUpperCase();
    const normalizedHash = hashCommentBody(body);
    const issueHashes = this.postedHashesByIssue.get(normalizedIssueIdentifier) ?? new Set<string>();
    if (issueHashes.has(normalizedHash)) return;

    const chunks = splitLinearCommentBody(body, this.maxCommentChars);
    let postedCount = 0;
    for (const chunk of chunks) {
      const posted = await this.postComment(normalizedIssueIdentifier, chunk);
      if (posted !== false) postedCount += 1;
    }

    if (postedCount === 0) return;

    issueHashes.add(normalizedHash);
    this.postedHashesByIssue.set(normalizedIssueIdentifier, issueHashes);
    this.logger.info(
      `[linear] Mirrored assistant output for ${normalizedIssueIdentifier} as ${postedCount} Linear comment(s)`,
    );
  }

  private handleAssistantEvent(event: AssistantMirrorAgentEvent): void {
    const issueIdentifier = issueIdentifierFromSessionKey(event.sessionKey);
    const existing = this.buffersByRunId.get(event.runId);
    if (!issueIdentifier && !existing) return;

    const buffer = existing ?? {
      issueIdentifier: issueIdentifier as string,
      text: "",
    };

    const data = event.data ?? {};
    const replace = data.replace === true;
    const delta = typeof data.delta === "string" ? data.delta : "";
    const text = typeof data.text === "string" ? data.text : "";

    if (replace && text) {
      buffer.text = text;
    } else if (delta) {
      buffer.text += delta;
    } else if (text) {
      buffer.text = mergeFullTextUpdate(buffer.text, text);
    }

    this.buffersByRunId.set(event.runId, buffer);
  }

  private async flushRun(runId: string): Promise<void> {
    const buffer = this.buffersByRunId.get(runId);
    if (!buffer) return;
    this.buffersByRunId.delete(runId);

    await this.mirrorText(buffer.issueIdentifier, buffer.text);
  }
}

function mergeFullTextUpdate(current: string, next: string): string {
  if (!current) return next;
  if (next === current || current.endsWith(next)) return current;
  if (next.startsWith(current)) return next;
  return current + next;
}

function isTerminalLifecycleEvent(event: AssistantMirrorAgentEvent): boolean {
  const phase = event.data?.phase;
  return phase === "end" || phase === "error";
}

function hashCommentBody(body: string): string {
  let hash = 0;
  for (let i = 0; i < body.length; i += 1) {
    hash = (hash * 31 + body.charCodeAt(i)) | 0;
  }
  return String(hash);
}
