import { Type, type Static } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import { execLinear, withTempFile } from "./linear-cli.js";

const Params = Type.Object({
  issueId: Type.String({ description: "Linear issue identifier (e.g. ENG-123)" }),
  state: Type.Optional(Type.String({ description: "New workflow state name (e.g. In Progress, Done)" })),
  assignee: Type.Optional(Type.String({ description: "Assignee display name or email" })),
  priority: Type.Optional(Type.String({ description: "Priority level (e.g. Urgent, High, Medium, Low, None)" })),
  labels: Type.Optional(Type.Array(Type.String(), { description: "Labels to set on the issue" })),
  title: Type.Optional(Type.String({ description: "New issue title" })),
  description: Type.Optional(Type.String({ description: "New issue description (markdown)" })),
  project: Type.Optional(Type.String({ description: "Project name to move the issue to" })),
});
type Params = Static<typeof Params>;

export function createIssueUpdateTool(): AnyAgentTool {
  return {
    name: "linear_issue_update",
    label: "Linear Issue Update",
    description:
      "Update a Linear issue's properties: state, assignee, priority, labels, title, description, or project.",
    parameters: Params,
    async execute(_toolCallId: string, params: Params) {
      try {
        const run = async (descriptionFile?: string) => {
          const args = ["issue", "update", params.issueId];

          if (params.state) args.push("--state", params.state);
          if (params.assignee) args.push("--assignee", params.assignee);
          if (params.priority) args.push("--priority", params.priority);
          if (params.title) args.push("--title", params.title);
          if (params.project) args.push("--project", params.project);
          if (params.labels) {
            for (const label of params.labels) {
              args.push("--label", label);
            }
          }
          if (descriptionFile) {
            args.push("--description-file", descriptionFile);
          }

          return execLinear(args);
        };

        const result = params.description !== undefined
          ? await withTempFile(params.description, (f) => run(f))
          : await run();

        if (result.exitCode !== 0) {
          return jsonResult({
            error: `Failed to update issue ${params.issueId}: ${result.stderr || result.stdout}`.trim(),
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
