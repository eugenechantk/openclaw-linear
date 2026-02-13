# @openclaw/linear

Linear project management integration for OpenClaw.

## Install

```bash
npm install @openclaw/linear
```

## Configuration

Add the plugin to your OpenClaw config and provide the required credentials:

```yaml
plugins:
  linear:
    apiKey: "<your-linear-api-key>"
    webhookSecret: "<your-linear-webhook-secret>"
```

Both `apiKey` and `webhookSecret` are sensitive fields and will be stored securely.

You can generate a Linear API key from **Settings > API** in your Linear workspace.

## Usage

Once configured, the Linear plugin activates automatically when OpenClaw starts. It provides integration with Linear's project management features including issues, projects, and teams.

## Development

```bash
npm install
npm run build
```

To type-check without emitting:

```bash
npx tsc --noEmit
```
