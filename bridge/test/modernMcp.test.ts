import assert from "node:assert/strict";
import { once } from "node:events";
import type http from "node:http";
import test from "node:test";
import { startMcpHttpServer } from "../src/mcpServer.js";
import { EditorStateStore } from "../src/stateStore.js";

const PROTOCOL_VERSION = "2026-07-28";
const META = {
  "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
  "io.modelcontextprotocol/clientInfo": { name: "bridge-modern-qa", version: "1.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

async function httpPort(server: http.Server): Promise<number> {
  if (!server.address()) await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP HTTP address");
  return address.port;
}

async function closeHttpServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function modernRpc(
  url: string,
  body: Record<string, unknown>,
  method: string,
  name?: string,
): Promise<{ response: Response; payload: any }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": PROTOCOL_VERSION,
    "mcp-method": method,
  };
  if (name) headers["mcp-name"] = name;
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await response.text();
  const payload = JSON.parse(text);
  return { response, payload };
}

test("MCP server supports the 2026-07-28 discover, list, and call request contract", async () => {
  const store = new EditorStateStore();
  const { server, closeMcp } = startMcpHttpServer({ port: 0, store });
  const port = await httpPort(server);
  const url = `http://127.0.0.1:${port}/mcp`;

  try {
    const discover = await modernRpc(
      url,
      { jsonrpc: "2.0", id: "discover-1", method: "server/discover", params: { _meta: META } },
      "server/discover",
    );
    assert.equal(discover.response.status, 200);
    assert.equal(discover.payload.jsonrpc, "2.0");
    assert.equal(discover.payload.id, "discover-1");
    assert.ok(discover.payload.result);

    const listed = await modernRpc(
      url,
      { jsonrpc: "2.0", id: "tools-1", method: "tools/list", params: { _meta: META } },
      "tools/list",
    );
    assert.equal(listed.response.status, 200);
    const names = (listed.payload.result?.tools ?? []).map((tool: { name: string }) => tool.name).sort();
    assert.deepEqual(names, [
      "get_active_editor",
      "get_diagnostics",
      "get_selection",
      "get_workspace",
      "read_file",
      "search_workspace",
    ]);

    const called = await modernRpc(
      url,
      {
        jsonrpc: "2.0",
        id: "call-1",
        method: "tools/call",
        params: { name: "get_workspace", arguments: {}, _meta: META },
      },
      "tools/call",
      "get_workspace",
    );
    assert.equal(called.response.status, 200);
    assert.equal(called.payload.result?.structuredContent?.vscodeConnected, false);

    const missingMethod = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": PROTOCOL_VERSION,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: "bad-1", method: "tools/list", params: { _meta: META } }),
    });
    assert.equal(missingMethod.status, 400);
    const error = await missingMethod.json() as { error?: { code?: number } };
    assert.equal(error.error?.code, -32020);
  } finally {
    await closeMcp();
    await closeHttpServer(server);
  }
});
