import { Type, type Static } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import { execLinear, withTempFile } from "./linear-cli.js";

const Params = Type.Object({
  title: Type.String({ description: "Issue title" }),
  description: Type.Optional(Type.String({ description: "Issue description (markdown)" })),
  assignee: Type.Optional(Type.String({ description: "Assignee display name or email" })),
  state: Type.Optional(Type.String({ description: "Initial workflow state name" })),
  priority: Type.Optional(Type.String({ description: "Priority level (e.g. Urgent, High, Medium, Low, None)" })),
  labels: Type.Optional(Type.Array(Type.String(), { description: "Labels to add to the issue" })),
  team: Type.Optional(Type.String({ description: "Team key (e.g. ENG). Required if user belongs to multiple teams." })),
  project: Type.Optional(Type.String({ description: "Project name" })),
  parent: Type.Optional(Type.String({ description: "Parent issue identifier for creating sub-issues (e.g. ENG-100)" })),
});
type Params = Static<typeof Params>;

export function createIssueCreateTool(): AnyAgentTool {
  return {
    name: "linear_issue_create",
    label: "Linear Issue Create",
    description:
      "Create a new Linear issue. Returns the issue identifier and URL on success.",
    parameters: Params,
    async execute(_toolCallId: string, params: Params) {
      try {
        const run = async (descriptionFile?: string) => {
          const args = ["issue", "create", "--title", params.title, "--no-interactive"];

          if (params.assignee) args.push("--assignee", params.assignee);
          if (params.state) args.push("--state", params.state);
          if (params.priority) args.push("--priority", params.priority);
          if (params.team) args.push("--team", params.team);
          if (params.project) args.push("--project", params.project);
          if (params.parent) args.push("--parent", params.parent);
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

        const result = params.description
          ? await withTempFile(params.description, (f) => run(f))
          : await run();

        if (result.exitCode !== 0) {
          return jsonResult({
            error: `Failed to create issue: ${result.stderr || result.stdout}`.trim(),
          });
        }

        return jsonResult({ success: true, stdout: result.stdout.trim() });
      } catch (err) {
        return jsonResult({
          error: `linear CLI error: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },
  };
}
