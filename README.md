# Fusen

Sticky notes on code lines for two-way review with AI agents (VS Code extension + MCP).

Leave comments on any line of your working tree, hand them to Claude Code or Codex CLI as one prompt, and let the agents post their own comments back onto the lines — which you approve or reject in the editor.

> Status: under development. Nothing is published yet.

## Packages

| Path | What it is |
| --- | --- |
| `packages/extension` | VS Code extension (also runs in Cursor) built on the Comments API |
| `packages/mcp-server` | stdio MCP server (`fusen-mcp`) that lets AI agents read and post comments |
| `e2e` | Playwright tests that launch VS Code with the extension and capture screenshots |

## Development

```sh
npm ci
npm run typecheck
npm run build
npm test
xvfb-run -a npm run test:e2e   # Linux; on macOS run `npm run test:e2e`
```

CI (`.github/workflows/ci.yml`) runs the same commands on every pull request and uploads E2E screenshots as the `e2e-screenshots` artifact.

Design notes: [documents/PROJECT.md](documents/PROJECT.md)

## License

MIT
