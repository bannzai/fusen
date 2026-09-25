import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("the stdio server completes the MCP handshake as fusen", async () => {
  const client = new Client({ name: "fusen-test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL("./index.js", import.meta.url))],
    }),
  );
  try {
    assert.equal(client.getServerVersion()?.name, "fusen");
  } finally {
    await client.close();
  }
});
