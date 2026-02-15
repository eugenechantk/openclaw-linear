import { Type, type Static } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import { execLinear } from "./linear-cli.js";

const Params = Type.Object({
  issueId: Type.String({ description: "Linear issue identifier (e.g. ENG-123)" }),
});
type Params = Static<typeof Params>;

export function createCommentListTool(): AnyAgentTool {
  return {
    name: "linear_comment_list",
    label: "Linear Comment List",
    description:
      "List all comments on a Linear issue. Returns an array of comment objects with id, body, author, and timestamps.",
    parameters: Params,
    async execute(_toolCallId: string, params: Params) {
      try {
        const result = await execLinear([
          "issue",
          "comment",
          "list",
          params.issueId,
          "--json",
        ]);

        if (result.exitCode !== 0) {
          return jsonResult({
            error: `Failed to list comments for ${params.issueId}: ${result.stderr || result.stdout}`.trim(),
          });
        }

        const comments = JSON.parse(result.stdout);
        return jsonResult(comments);
      } catch (err) {
        return jsonResult({
          error: `linear CLI error: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },
  };
}
