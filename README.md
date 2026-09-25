# Fusen

Sticky notes on code lines for two-way review with AI agents (VS Code extension + MCP).

Leave comments on any line of your working tree, hand them to Claude Code or Codex CLI as one prompt, and let the agents post their own comments back onto the lines — which you approve or reject in the editor.

> Status: under development. Nothing is published yet; until the first release, use the VSIX from CI and run the MCP server from a clone.

## Packages

| Path | What it is |
| --- | --- |
| `packages/extension` | VS Code extension (also runs in Cursor) built on the Comments API |
| `packages/mcp-server` | stdio MCP server (`fusen-mcp`) that lets AI agents read and post comments |
| `e2e` | Playwright tests that launch VS Code with the extension and capture screenshots |

## Install the extension

Fusen is distributed only as a VSIX file, not on the VS Code Marketplace or Open VSX. Download `fusen-<version>.vsix` from a GitHub release (https://github.com/bannzai/fusen/releases), or before the first release from the `fusen-vsix` artifact of a CI run:

```sh
gh run download <run-id> --repo bannzai/fusen -n fusen-vsix
```

Then install it:

```sh
code --install-extension fusen-<version>.vsix     # VS Code
cursor --install-extension fusen-<version>.vsix   # Cursor
```

To build the VSIX yourself from a clone: `npm ci && npm run build && npm run package --workspace packages/extension` (writes `packages/extension/fusen-<version>.vsix`).

## Register the MCP server

From its first release, the server is on npm as `fusen-mcp` and runs with `npx -y fusen-mcp`. Until then, register it from a clone (see below).

### Claude Code

```sh
claude mcp add fusen -- npx -y fusen-mcp
```

Add `--scope project` to share the registration with the repository instead; it is written to `.mcp.json` at the project root:

```json
{
  "mcpServers": {
    "fusen": {
      "command": "npx",
      "args": ["-y", "fusen-mcp"]
    }
  }
}
```

### Codex CLI

```sh
codex mcp add fusen -- npx -y fusen-mcp
```

or add it to `~/.codex/config.toml`:

```toml
[mcp_servers.fusen]
command = "npx"
args = ["-y", "fusen-mcp"]
```

### From a clone (before the npm release)

Build the server once, then register it with its absolute path:

```sh
git clone https://github.com/bannzai/fusen
cd fusen
npm ci
npm run build
claude mcp add fusen -- node "$PWD/packages/mcp-server/out/index.js"
codex mcp add fusen -- node "$PWD/packages/mcp-server/out/index.js"
```

In `.mcp.json` or `~/.codex/config.toml`, use `"command": "node"` / `command = "node"` with the absolute path of `packages/mcp-server/out/index.js` as the only argument.

## Development

```sh
npm ci
npm run typecheck
npm run build
npm test
xvfb-run -a npm run test:e2e   # Linux; on macOS run `npm run test:e2e`
```

CI (`.github/workflows/ci.yml`) runs the same commands on every pull request, uploads E2E screenshots as the `e2e-screenshots` artifact and the packaged extension as the `fusen-vsix` artifact.

Design notes: [documents/PROJECT.md](documents/PROJECT.md)

## Release

`.github/workflows/release.yml` publishes a release when a `v<version>` tag is pushed:

1. Set the same `version` in `packages/extension/package.json` and `packages/mcp-server/package.json`. For the first npm release, also remove `"private": true` from `packages/mcp-server/package.json`; while it is there, publishing fails.
2. Push the tag, for example `git tag v0.1.0 && git push origin v0.1.0`. The workflow checks the versions against the tag, publishes `fusen-mcp` to npm with the `NPM_TOKEN` secret, and creates a GitHub release with the VSIX attached.

Running the workflow manually (`gh workflow run release.yml --ref <branch>`) is a dry run: it packages the VSIX and runs `npm publish --dry-run` without creating a release.

## License

MIT
