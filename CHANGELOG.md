# Changelog

The VS Code extension (`fusen-<version>.vsix`) and the MCP server (`fusen-mcp.mjs`) are released together under the same version, as files attached to a GitHub release.

## 0.1.0

First release.

- Extension: add notes on any line or range of any file in the workspace from the gutter, reply to them, and edit or delete them. Notes are stored in `.fusen/threads/` and restored when the workspace is opened again
- Extension: notes follow their code through edits in the editor and changes outside it (git checkout, an agent rewriting the file), and are labelled "Location unknown" when the code is gone
- Extension: `Fusen: Copy comments as prompt` and `Fusen: Export comments as prompt to .fusen/prompt.md` turn the notes into one markdown prompt for an AI agent
- Extension: comments that an agent posts over MCP appear as "Pending approval" and become regular notes only when approved in the editor
- MCP server: `list_comments`, `get_file_comments` and `get_prompt` read the notes, and `post_comment`, `reply_to_thread` and `get_proposal_status` let an agent propose comments and follow the human's decision
