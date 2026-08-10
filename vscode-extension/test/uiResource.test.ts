import assert from "node:assert/strict";
import test from "node:test";
import {
  TOOLS,
  WORKSPACE_WIDGET_HTML,
  WORKSPACE_WIDGET_MIME,
  WORKSPACE_WIDGET_URI,
  handleMcpRequestCore,
  type CloudMcpRequest,
} from "../src/mcpProtocol.js";

function request(method: string, params: Record<string, unknown> = {}): CloudMcpRequest {
  return {
    type: "mcp_request",
    requestId: `ui-${method}`,
    method: "POST",
    headers: {},
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  };
}

const callTool = async (): Promise<Record<string, unknown>> => ({
  resultType: "complete",
  content: [],
  structuredContent: { vscodeConnected: true, workspaceFolders: [], activeFile: null },
});

test("get_workspace advertises one MCP Apps workspace status UI", () => {
  const tool = TOOLS.find((item) => item.name === "get_workspace");
  assert.ok(tool);
  assert.equal((tool._meta?.ui as { resourceUri?: string } | undefined)?.resourceUri, WORKSPACE_WIDGET_URI);
  assert.equal(tool._meta?.["openai/outputTemplate"], WORKSPACE_WIDGET_URI);
  assert.equal(tool._meta?.["openai/widgetAccessible"], true);
});

test("resources/list publishes the workspace status resource", async () => {
  const response = await handleMcpRequestCore(request("resources/list"), callTool);
  assert.equal(response.status, 200);
  const payload = JSON.parse(response.body);
  assert.equal(payload.result.resources.length, 1);
  assert.equal(payload.result.resources[0].uri, WORKSPACE_WIDGET_URI);
  assert.equal(payload.result.resources[0].mimeType, WORKSPACE_WIDGET_MIME);
});

test("resources/read returns a self-contained MCP Apps widget", async () => {
  const response = await handleMcpRequestCore(request("resources/read", { uri: WORKSPACE_WIDGET_URI }), callTool);
  assert.equal(response.status, 200);
  const payload = JSON.parse(response.body);
  const content = payload.result.contents[0];
  assert.equal(content.uri, WORKSPACE_WIDGET_URI);
  assert.equal(content.mimeType, WORKSPACE_WIDGET_MIME);
  assert.equal(content.text, WORKSPACE_WIDGET_HTML);
  assert.match(content.text, /ui\/notifications\/tool-result/);
  assert.match(content.text, /tools\/call/);
  assert.match(content.text, /Refresh from VS Code/);
  assert.equal(content._meta.ui.prefersBorder, true);
});

test("resources/read rejects unknown resource URIs", async () => {
  const response = await handleMcpRequestCore(request("resources/read", { uri: "ui://chatgpt-bridge/missing.html" }), callTool);
  assert.equal(response.status, 404);
  assert.equal(JSON.parse(response.body).error.code, -32004);
});
