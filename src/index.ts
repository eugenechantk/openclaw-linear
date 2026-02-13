import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

export function activate(api: OpenClawPluginApi): void {
  api.logger.info("Linear plugin activated");
}

export function deactivate(api: OpenClawPluginApi): void {
  api.logger.info("Linear plugin deactivated");
}

const plugin = {
  id: "linear",
  name: "Linear",
  description: "Linear project management integration for OpenClaw",
  activate,
} satisfies {
  id: string;
  name: string;
  description: string;
  activate: (api: OpenClawPluginApi) => void;
};

export default plugin;
