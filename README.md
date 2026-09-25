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

### Which workspace the server reads

The server reads and writes the `.fusen/` directory of one workspace folder, chosen in this order:

1. The `--workspace <path>` argument (a relative path is resolved against the working directory)
2. The `CLAUDE_PROJECT_DIR` environment variable, which Claude Code sets to the project root for the MCP servers it starts
3. The working directory the server was started in

Claude Code therefore needs no extra setting. Codex CLI does not tell the server which project it works on, so give it the project with `cwd` or `--workspace` (see below).

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

Register it per project in `.codex/config.toml` at the project root (Codex CLI loads it for trusted projects), with `cwd` set to the project:

```toml
[mcp_servers.fusen]
command = "npx"
args = ["-y", "fusen-mcp"]
cwd = "/absolute/path/to/project"
```

or pass the project as an argument, which also works in `~/.codex/config.toml` or with `codex mcp add`:

```sh
codex mcp add fusen -- npx -y fusen-mcp --workspace /absolute/path/to/project
```

```toml
[mcp_servers.fusen]
command = "npx"
args = ["-y", "fusen-mcp", "--workspace", "/absolute/path/to/project"]
```

Without either, the server uses the directory Codex CLI started it in.

### From a clone (before the npm release)

Build the server once, then register it with its absolute path:

```sh
git clone https://github.com/bannzai/fusen
cd fusen
npm ci
npm run build
claude mcp add fusen -- node "$PWD/packages/mcp-server/dist/index.js"
codex mcp add fusen -- node "$PWD/packages/mcp-server/dist/index.js" --workspace /absolute/path/to/project
```

In `.mcp.json` or `.codex/config.toml`, use `"command": "node"` / `command = "node"` with the absolute path of `packages/mcp-server/dist/index.js` as the first argument, followed by `--workspace <path>` for Codex CLI.

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
