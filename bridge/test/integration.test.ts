import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import WebSocket, { type WebSocketServer } from "ws";
import { startEditorSocketServer } from "../src/editorSocketServer.js";
import { startMcpHttpServer } from "../src/mcpServer.js";
import { EditorStateStore } from "../src/stateStore.js";
import type { EditorSnapshot } from "../src/types.js";

const validSnapshot: EditorSnapshot = {
  type: "editor_snapshot",
  workspaceFolders: ["C:\\workspace"],
  activeFile: "C:\\workspace\\index.ts",
  languageId: "typescript",
  dirty: true,
  content: "const selected = true;",
  contentTruncated: false,
  selection: {
    text: "selected",
    start: { line: 0, character: 6 },
    end: { line: 0, character: 14 },
    isEmpty: false,
    truncated: false,
  },
  diagnostics: [],
  diagnosticsTruncated: false,
  capturedAt: "2026-08-08T00:00:00.000Z",
};

async function wsPort(server: WebSocketServer): Promise<number> {
  if (!server.address()) await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP WebSocket address");
  return address.port;
}

async function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  for (const client of server.clients) client.terminate();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function httpPort(server: http.Server): Promise<number> {
  if (!server.address()) await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP HTTP address");
  return address.port;
}

async function closeHttpServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function parseRpcPayload(text: string, contentType: string): any {
  if (!contentType.includes("text/event-stream")) return JSON.parse(text);

  const payloads = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  if (payloads.length === 0) throw new Error("SSE response contained no JSON data event.");
  return payloads[payloads.length - 1];
}

async function rpc(url: string, body: unknown): Promise<any> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  const text = await response.text();
  return parseRpcPayload(text, response.headers.get("content-type") ?? "");
}

function requestWithHost(port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/health",
        method: "GET",
        headers: { host },
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      },
    );
    request.once("error", reject);
    request.end();
  });
}

test("WebSocket bridge rejects a bad token and accepts a validated editor snapshot", async () => {
  const store = new EditorStateStore();
  const server = startEditorSocketServer({ port: 0, token: "a".repeat(64), store });
  const port = await wsPort(server);

  try {
    const bad = new WebSocket(`ws://127.0.0.1:${port}`);
    await once(bad, "open");
    bad.send(JSON.stringify({ type: "hello", token: "wrong", client: "vscode", version: "0.1.0" }));
    const [badCode] = await once(bad, "close");
    assert.equal(badCode, 1008);
    assert.equal(store.isVscodeConnected(), false);

    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    await once(client, "open");
    client.send(JSON.stringify({ type: "hello", token: "a".repeat(64), client: "vscode", version: "0.1.0" }));
    const [readyRaw] = await once(client, "message");
    const ready = JSON.parse(readyRaw.toString("utf8")) as { type?: string };
    assert.equal(ready.type, "ready");
    assert.equal(store.isVscodeConnected(), true);

    client.send(JSON.stringify(validSnapshot));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(store.getSnapshot(), validSnapshot);

    client.send(JSON.stringify({ ...validSnapshot, dirty: "not-a-boolean" }));
    const [invalidCode] = await once(client, "close");
    assert.equal(invalidCode, 1008);
    assert.equal(store.isVscodeConnected(), false);
  } finally {
    await closeWebSocketServer(server);
  }
});

test("MCP HTTP server exposes health/tools, serves live selection, and rejects hostile Host headers", async () => {
  const store = new EditorStateStore();
  store.connected();
  store.update(validSnapshot);
  const { server, closeMcp } = startMcpHttpServer({ port: 0, store });
  const port = await httpPort(server);
  const mcpUrl = `http://127.0.0.1:${port}/mcp`;

  try {
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, vscodeConnected: true });

    const hostileStatus = await requestWithHost(port, "evil.example");
    assert.ok(hostileStatus >= 400 && hostileStatus < 500);

    const initialized = await rpc(mcpUrl, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "bridge-qa", version: "1.0.0" },
      },
    });
    assert.equal(initialized.jsonrpc, "2.0");
    assert.ok(initialized.result?.serverInfo?.name);

    const tools = await rpc(mcpUrl, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const names = (tools.result?.tools ?? []).map((tool: { name: string }) => tool.name).sort();
    assert.deepEqual(names, [
      "get_active_editor",
      "get_diagnostics",
      "get_selection",
      "get_workspace",
      "read_file",
      "search_workspace",
    ]);

    const selection = await rpc(mcpUrl, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "get_selection", arguments: {} },
    });
    assert.equal(selection.result?.structuredContent?.selection?.text, "selected");
  } finally {
    await closeMcp();
    await closeHttpServer(server);
  }
});
