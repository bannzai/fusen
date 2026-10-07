# Install Fusen from the latest GitHub release: the extension into an editor, and the MCP server into an agent.
# Every install target downloads the latest release again and overwrites the previous files, so re-running it upgrades.
# `make` without a target runs `vscode`, which installs the latest release into VS Code to try it by hand.
# Checks and tests are run by CI; `make verify` (at the end of this file) runs the ones of the build-test job locally.

# Where the release files are kept; the MCP server is registered with its path here, so it must stay.
FUSEN_DIR ?= $(HOME)/.fusen
REPO := bannzai/fusen
VSIX := $(FUSEN_DIR)/fusen.vsix
MCP_SERVER := $(FUSEN_DIR)/fusen-mcp.mjs

.PHONY: download cursor vscode claude codex

## download: download the extension and the MCP server of the latest release into FUSEN_DIR
download:
	mkdir -p $(FUSEN_DIR)
	gh release download --repo $(REPO) --pattern 'fusen-*.vsix' --output $(VSIX) --clobber
	gh release download --repo $(REPO) --pattern 'fusen-mcp.mjs' --dir $(FUSEN_DIR) --clobber

## cursor: install the extension into Cursor
cursor: download
	cursor --install-extension $(VSIX) --force

## vscode: install the extension into VS Code
vscode: download
	code --install-extension $(VSIX) --force

# The server is registered for every project (user scope); it reads the project that Claude Code passes in CLAUDE_PROJECT_DIR.
## claude: register the MCP server with Claude Code
claude: download
	-claude mcp remove fusen --scope user
	claude mcp add fusen --scope user -- node $(MCP_SERVER)

# Codex CLI starts the server in the directory Codex runs in, so one registration serves every project started from its own directory.
## codex: register the MCP server with Codex CLI
codex: download
	-codex mcp remove fusen
	codex mcp add fusen -- node $(MCP_SERVER)

# `make` without a target installs the extension into VS Code, the editor Fusen is built for (it also runs in Cursor: `make cursor`).
.DEFAULT_GOAL := vscode

.PHONY: verify
verify:
	npm ci
	npm run typecheck
	npm run build
	npm test
