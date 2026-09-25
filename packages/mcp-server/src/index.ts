#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

// The working directory is the workspace folder whose `.fusen/` the server reads and writes,
// so a registration in an MCP client starts the server in the project directory.
await createServer(process.cwd()).connect(new StdioServerTransport());
