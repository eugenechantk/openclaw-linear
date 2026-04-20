import type { RouterAction } from "./event-router.js";
import type { LinearDebugLogger } from "./debug-log.js";
import type { IssueWorkCompletionResult, IssueWorkStore } from "./issue-work-store.js";
import type { EnqueueEntry, QueueItem } from "./work-queue.js";

export type IssueWorkDispatchDecision =
  | {
      type: "no_actions";
    }
  | {
      type: "not_dispatchable";
      issueId: string;
      reason: "deduped_or_stored_pending_followup" | "claim_failed" | "assignment_failed";
    }
  | {
      type: "dispatched";
      issueId: string;
      item: QueueItem;
    };

export type IssueWorkDispatcherDeps = {
  store: IssueWorkStore;
  logger: {
    info: (message: string) => void;
    error: (message: string) => void;
  };
  debugLog?: Pick<LinearDebugLogger, "append">;
  assignIssueOwner?: (issueId: string) => Promise<void>;
  moveIssueToReview?: (issueId: string) => Promise<void>;
  dispatchIssueSession: (params: {
    issueId: string;
    fallbackAgentId: string;
    actions?: RouterAction[];
  }) => Promise<void>;
};

export type IssueWorkCompletionDecision =
  | {
      type: "not_completed";
      issueId: string;
      reason: "not_found" | "codex_still_running";
      result: IssueWorkCompletionResult;
    }
  | {
      type: "completed";
      issueId: string;
      transition: "in_review" | "blocked";
      result: IssueWorkCompletionResult;
    }
  | {
      type: "dispatched_followup";
      issueId: string;
      result: IssueWorkCompletionResult;
      dispatch: IssueWorkDispatchDecision;
  };

export type IssueWorkBacklogDispatchResult = {
  attempted: number;
  dispatched: number;
  decisions: IssueWorkDispatchDecision[];
};

function entriesFromActions(actions: RouterAction[]): EnqueueEntry[] {
  return actions.map((action) => ({
    id: action.commentId || action.identifier,
    issueId: action.identifier,
    linearIssueUuid: action.issueId,
    event: action.event,
    summary: action.issueLabel,
    issuePriority: action.issuePriority,
    commentBody: action.commentBody,
    createdAt: action.createdAt,
  }));
}

/**
 * Deterministic state machine for moving Linear issue work from normalized
 * route actions into issue-scoped sessions.
 */
export class IssueWorkDispatcher {
  constructor(private readonly deps: IssueWorkDispatcherDeps) {}

  async dispatchActions(actions: RouterAction[]): Promise<IssueWorkDispatchDecision> {
    if (actions.length === 0) return { type: "no_actions" };

    const first = actions[0];
    const issueId = first.identifier;
    const added = await this.deps.store.enqueue(entriesFromActions(actions));
    this.deps.debugLog?.append({
      type: "dispatcher.enqueue",
      issueId,
      count: actions.length,
      dispatchableCount: added,
      eventTypes: actions.map((action) => action.event),
      deliveryIds: actions.map((action) => action.commentId || action.identifier),
    });

    if (added === 0) {
      this.deps.logger.info(
        `[linear] Issue work for ${issueId} did not create dispatchable work; it was deduped or stored as a pending follow-up`,
      );
      return {
        type: "not_dispatchable",
        issueId,
        reason: "deduped_or_stored_pending_followup",
      };
    }

    return this.dispatchPendingIssueWork(issueId, first.agentId, actions);
  }

  async dispatchPendingIssueWork(
    issueId: string,
    fallbackAgentId = "main",
    actions?: RouterAction[],
  ): Promise<IssueWorkDispatchDecision> {
    const item = await this.deps.store.claim(issueId);
    if (!item) {
      this.deps.logger.info(`[linear] No claimable issue work for ${issueId}; skipping session dispatch`);
      this.deps.debugLog?.append({
        type: "dispatcher.claim_failed",
        issueId,
        fallbackAgentId,
      });
      return {
        type: "not_dispatchable",
        issueId,
        reason: "claim_failed",
      };
    }

    try {
      await this.deps.assignIssueOwner?.(issueId);
    } catch (err) {
      const released = this.deps.store.releaseClaim(issueId, item.leaseOwner);
      this.deps.debugLog?.append({
        type: "dispatcher.assignment_failed",
        issueId,
        fallbackAgentId,
        released,
        error: err instanceof Error ? err.message : String(err),
      });
      this.deps.logger.error(
        `[linear] Issue assignment failed for ${issueId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return {
        type: "not_dispatchable",
        issueId,
        reason: "assignment_failed",
      };
    }

    this.deps.dispatchIssueSession({
      issueId,
      fallbackAgentId,
      actions,
    })
      .catch((err) => {
        const released = this.deps.store.releaseClaim(issueId, item.leaseOwner);
        this.deps.debugLog?.append({
          type: "dispatcher.dispatch_failed",
          issueId,
          fallbackAgentId,
          released,
          error: err instanceof Error ? err.message : String(err),
        });
        this.deps.logger.error(
          `[linear] Issue session dispatch failed for ${issueId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });

    this.deps.debugLog?.append({
      type: "dispatcher.dispatched",
      issueId,
      sessionKey: this.deps.store.getWork(issueId)?.sessionKey,
      fallbackAgentId,
      item,
    });

    return {
      type: "dispatched",
      issueId,
      item,
    };
  }

  async dispatchPendingBacklog(fallbackAgentId = "main"): Promise<IssueWorkBacklogDispatchResult> {
    const pending = await this.deps.store.peek();
    const decisions: IssueWorkDispatchDecision[] = [];
    let dispatched = 0;

    this.deps.debugLog?.append({
      type: "dispatcher.backlog_scan",
      count: pending.length,
      issueIds: pending.map((item) => item.issueId),
    });

    for (const item of pending) {
      try {
        const decision = await this.dispatchPendingIssueWork(item.issueId, fallbackAgentId);
        decisions.push(decision);
        if (decision.type === "dispatched") dispatched += 1;
      } catch (err) {
        this.deps.logger.error(
          `[linear] Pending issue work dispatch failed for ${item.issueId}: ${err instanceof Error ? err.message : String(err)}`,
        );
        decisions.push({
          type: "not_dispatchable",
          issueId: item.issueId,
          reason: "claim_failed",
        });
      }
    }

    return {
      attempted: pending.length,
      dispatched,
      decisions,
    };
  }

  async completeIssueWork(issueId: string): Promise<IssueWorkCompletionDecision> {
    const work = this.deps.store.getWork(issueId);
    const activeRun = work?.activeCodexRunId
      ? this.deps.store.getCodexRun(work.activeCodexRunId)
      : null;
    const result = this.deps.store.completeIssueWork(issueId, {
      activeRunStatus: activeRun?.status ?? null,
    });
    this.deps.debugLog?.append({
      type: "dispatcher.complete",
      issueId,
      activeRunStatus: activeRun?.status ?? null,
      result,
      sessionKey: work?.sessionKey,
    });

    if (result.transition === "not_found") {
      return {
        type: "not_completed",
        issueId,
        reason: "not_found",
        result,
      };
    }

    if (result.transition === "codex_still_running") {
      this.deps.logger.info(
        `[linear] Completion deferred for ${issueId}; Codex run ${result.activeCodexRunId ?? "unknown"} is still running`,
      );
      return {
        type: "not_completed",
        issueId,
        reason: "codex_still_running",
        result,
      };
    }

    if (result.transition === "pending_followup") {
      const dispatch = await this.dispatchPendingIssueWork(issueId);
      return {
        type: "dispatched_followup",
        issueId,
        result,
        dispatch,
      };
    }

    if (result.transition === "in_review") {
      await this.deps.moveIssueToReview?.(issueId);
    }

    return {
      type: "completed",
      issueId,
      transition: result.transition,
      result,
    };
  }
}
