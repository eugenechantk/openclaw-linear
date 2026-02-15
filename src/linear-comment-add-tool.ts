import { Type, type Static } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import { execLinear, withTempFile } from "./linear-cli.js";

const Params = Type.Object({
  issueId: Type.String({ description: "Linear issue identifier (e.g. ENG-123)" }),
  body: Type.String({ description: "Comment body (markdown supported)" }),
  parentCommentId: Type.Optional(
    Type.String({ description: "Parent comment ID for threading a reply" }),
  ),
});
type Params = Static<typeof Params>;

export function createCommentAddTool(): AnyAgentTool {
  return {
    name: "linear_comment_add",
    label: "Linear Comment Add",
    description:
      "Add a comment to a Linear issue. Supports markdown. Optionally thread as a reply to an existing comment.",
    parameters: Params,
    async execute(_toolCallId: string, params: Params) {
      try {
        const result = await withTempFile(params.body, async (bodyFile) => {
          const args = [
            "issue",
            "comment",
            "add",
            params.issueId,
            "--body-file",
            bodyFile,
          ];
          if (params.parentCommentId) {
            args.push("--parent", params.parentCommentId);
          }
          return execLinear(args);
        });

        if (result.exitCode !== 0) {
          return jsonResult({
            error: `Failed to add comment to ${params.issueId}: ${result.stderr || result.stdout}`.trim(),
          });
        }

        return jsonResult({ success: true, issueId: params.issueId });
      } catch (err) {
        return jsonResult({
          error: `linear CLI error: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },
  };
}
