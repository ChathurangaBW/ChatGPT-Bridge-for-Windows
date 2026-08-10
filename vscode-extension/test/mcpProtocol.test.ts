import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_MCP_RESPONSE_BYTES,
  PROTOCOL_2025,
  PROTOCOL_2026,
  TOOLS,
  handleMcpRequestCore,
  type CloudMcpRequest,
} from "../src/mcpProtocol.js";

function request(body: unknown, headers: Record<string, string> = {}): CloudMcpRequest {
  return {
    type: "mcp_request",
    requestId: "rpc-test",
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  };
}

const callTool = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => ({
  resultType: "complete",
  content: [{ type: "text", text: `${name}:${JSON.stringify(args)}` }],
  structuredContent: { name, args },
});

test("VSIX MCP publishes exactly six read-only non-destructive tools", async () => {
  const response = await handleMcpRequestCore(
    request({ jsonrpc: "2.0", id: "list", method: "tools/list", params: {} }),
    callTool,
  );
  assert.equal(response.status, 200);
  const payload = JSON.parse(response.body);
  const tools = payload.result.tools as typeof TOOLS;
  assert.deepEqual(tools.map((tool) => tool.name), [
    "get_workspace",
    "get_active_editor",
    "get_selection",
    "get_diagnostics",
    "read_file",
    "search_workspace",
  ]);
  for (const tool of tools) {
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.destructiveHint, false);
    assert.equal(tool.annotations.openWorldHint, false);
  }
  for (const forbidden of ["run_command", "shell", "terminal", "write_file", "edit_file", "delete_file", "git_commit", "git_push", "run_tests", "install_package", "execute_code"]) {
    assert.equal(tools.some((tool) => tool.name === forbidden), false);
  }
});

test("VSIX MCP supports modern 2026 discovery and routed tool calls including Mcp-Param headers", async () => {
  const discover = await handleMcpRequestCore(
    request(
      { jsonrpc: "2.0", id: "discover", method: "server/discover", params: {} },
      { "mcp-protocol-version": PROTOCOL_2026, "mcp-method": "server/discover" },
    ),
    callTool,
  );
  assert.equal(discover.status, 200);
  assert.deepEqual(JSON.parse(discover.body).result.supportedVersions, [PROTOCOL_2026, PROTOCOL_2025]);

  const called = await handleMcpRequestCore(
    request(
      { jsonrpc: "2.0", id: "call", method: "tools/call", params: { name: "get_workspace", arguments: { sample: true } } },
      {
        "mcp-protocol-version": PROTOCOL_2026,
        "mcp-method": "tools/call",
        "mcp-name": "get_workspace",
        "mcp-param-tenant": "tenant-1",
      },
    ),
    callTool,
  );
  assert.equal(called.status, 200);
  assert.deepEqual(JSON.parse(called.body).result.structuredContent, { name: "get_workspace", args: { sample: true } });
});

test("VSIX MCP rejects missing or contradictory modern routing metadata", async () => {
  const missingMethod = await handleMcpRequestCore(
    request(
      { jsonrpc: "2.0", id: "missing", method: "tools/list", params: {} },
      { "mcp-protocol-version": PROTOCOL_2026 },
    ),
    callTool,
  );
  assert.equal(missingMethod.status, 400);
  assert.equal(JSON.parse(missingMethod.body).error.code, -32020);

  const wrongMethod = await handleMcpRequestCore(
    request(
      { jsonrpc: "2.0", id: "wrong-method", method: "tools/call", params: { name: "get_workspace", arguments: {} } },
      { "mcp-protocol-version": PROTOCOL_2026, "mcp-method": "tools/list", "mcp-name": "get_workspace" },
    ),
    callTool,
  );
  assert.equal(wrongMethod.status, 400);

  const wrongName = await handleMcpRequestCore(
    request(
      { jsonrpc: "2.0", id: "wrong-name", method: "tools/call", params: { name: "get_workspace", arguments: {} } },
      { "mcp-protocol-version": PROTOCOL_2026, "mcp-method": "tools/call", "mcp-name": "read_file" },
    ),
    callTool,
  );
  assert.equal(wrongName.status, 400);
  assert.equal(JSON.parse(wrongName.body).error.code, -32020);
});

test("VSIX MCP preserves legacy 2025 initialize/list/call compatibility", async () => {
  const initialize = await handleMcpRequestCore(
    request({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL_2025 } }),
    callTool,
  );
  assert.equal(initialize.status, 200);
  assert.equal(JSON.parse(initialize.body).result.protocolVersion, PROTOCOL_2025);

  const list = await handleMcpRequestCore(request({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }), callTool);
  assert.equal(list.status, 200);

  const call = await handleMcpRequestCore(
    request({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_workspace", arguments: {} } }),
    callTool,
  );
  assert.equal(call.status, 200);
});

test("VSIX MCP returns protocol-safe errors for malformed JSON, invalid requests, methods, and tools", async () => {
  const malformed = await handleMcpRequestCore(request("{"), callTool);
  assert.equal(malformed.status, 400);
  assert.equal(JSON.parse(malformed.body).error.code, -32700);

  const invalid = await handleMcpRequestCore(request({ jsonrpc: "1.0", id: 1 }), callTool);
  assert.equal(invalid.status, 400);
  assert.equal(JSON.parse(invalid.body).error.code, -32600);

  const method = await handleMcpRequestCore(request({ jsonrpc: "2.0", id: 2, method: "no/such/method" }), callTool);
  assert.equal(method.status, 404);
  assert.equal(JSON.parse(method.body).error.code, -32601);

  const tool = await handleMcpRequestCore(
    request({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "run_command", arguments: {} } }),
    callTool,
  );
  assert.equal(tool.status, 404);
  assert.equal(JSON.parse(tool.body).error.code, -32602);
});

test("VSIX MCP hard-stops oversized serialized responses", async () => {
  const hugeCaller = async (): Promise<Record<string, unknown>> => ({
    resultType: "complete",
    content: [{ type: "text", text: "\\".repeat(MAX_MCP_RESPONSE_BYTES) }],
  });
  const response = await handleMcpRequestCore(
    request({ jsonrpc: "2.0", id: "huge", method: "tools/call", params: { name: "get_workspace", arguments: {} } }),
    hugeCaller,
  );
  assert.equal(response.status, 413);
  assert.equal(JSON.parse(response.body).error.code, -32002);
});
