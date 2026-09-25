#!/usr/bin/env node
import path from "node:path";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

// The workspace folder whose `.fusen/` the server reads and writes. Claude Code sets CLAUDE_PROJECT_DIR to the project root
// for the servers it starts, so its registrations need no argument; other clients pass --workspace or start the server there.
const { values } = parseArgs({ options: { workspace: { type: "string" } } });
await createServer(path.resolve(values.workspace ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd())).connect(
  new StdioServerTransport(),
);
