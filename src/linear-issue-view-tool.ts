import { Type, type Static } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import { execLinear } from "./linear-cli.js";

const Params = Type.Object({
  issueId: Type.String({ description: "Linear issue identifier (e.g. ENG-123)" }),
});
type Params = Static<typeof Params>;

export function createIssueViewTool(): AnyAgentTool {
  return {
    name: "linear_issue_view",
    label: "Linear Issue View",
    description:
      "View a Linear issue's full details including title, description, state, assignee, priority, labels, and comments.",
    parameters: Params,
    async execute(_toolCallId: string, params: Params) {
      try {
        const result = await execLinear([
          "issue",
          "view",
          params.issueId,
          "--json",
        ]);

        if (result.exitCode !== 0) {
          return jsonResult({
            error: `Failed to view issue ${params.issueId}: ${result.stderr || result.stdout}`.trim(),
          });
        }

        const issue = JSON.parse(result.stdout);
        return jsonResult(issue);
      } catch (err) {
        return jsonResult({
          error: `linear CLI error: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },
  };
}
