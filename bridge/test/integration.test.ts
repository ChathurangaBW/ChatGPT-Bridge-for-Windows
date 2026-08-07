import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
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

async function openAuthenticatedClient(port: number, token: string): Promise<WebSocket> {
  const client = new WebSocket(`ws://127.0.0.1:${port}`);
  await once(client, "open");
  client.send(JSON.stringify({ type: "hello", token, client: "vscode", version: "0.1.0" }));
  const [readyRaw] = await once(client, "message");
  const ready = JSON.parse(readyRaw.toString("utf8")) as { type?: string };
  assert.equal(ready.type, "ready");
  return client;
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

test("WebSocket bridge rejects a bad token and drops invalid-session snapshots immediately", async () => {
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

    const client = await openAuthenticatedClient(port, "a".repeat(64));
    assert.equal(store.isVscodeConnected(), true);

    client.send(JSON.stringify(validSnapshot));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(store.getSnapshot(), validSnapshot);

    client.send(JSON.stringify({ ...validSnapshot, dirty: "not-a-boolean" }));
    client.send(JSON.stringify({ ...validSnapshot, content: "must-not-apply-after-policy-violation" }));
    const [invalidCode] = await once(client, "close");
    assert.equal(invalidCode, 1008);
    assert.equal(store.isVscodeConnected(), false);
    assert.equal(store.getSnapshot(), null);
  } finally {
    await closeWebSocketServer(server);
  }
});

test("WebSocket bridge keeps snapshots isolated across multiple VS Code windows", async () => {
  const token = "b".repeat(64);
  const store = new EditorStateStore();
  const server = startEditorSocketServer({ port: 0, token, store });
  const port = await wsPort(server);

  try {
    const windowA = await openAuthenticatedClient(port, token);
    const windowB = await openAuthenticatedClient(port, token);
    const snapshotA = { ...validSnapshot, content: "window-a" };
    const snapshotB = { ...validSnapshot, activeFile: "C:\\workspace-b\\index.ts", content: "window-b" };

    windowA.send(JSON.stringify(snapshotA));
    await new Promise((resolve) => setTimeout(resolve, 20));
    windowB.send(JSON.stringify(snapshotB));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(store.getSnapshot(), snapshotB);

    windowB.close();
    await once(windowB, "close");
    assert.equal(store.isVscodeConnected(), true);
    assert.deepEqual(store.getSnapshot(), snapshotA);

    windowA.close();
    await once(windowA, "close");
    assert.equal(store.isVscodeConnected(), false);
    assert.equal(store.getSnapshot(), null);
  } finally {
    await closeWebSocketServer(server);
  }
});

test("MCP server enforces workspace editor privacy, tool behavior, and hostile Host rejection", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "chatgpt-bridge-mcp-"));
  const workspace = path.join(tempRoot, "workspace");
  const workspaceFile = path.join(workspace, "index.ts");
  const outsideFile = path.join(tempRoot, "outside-secret.txt");
  await mkdir(workspace);
  await writeFile(workspaceFile, "const selected = true;\nsecond line\n", "utf8");
  await writeFile(outsideFile, "DO_NOT_EXPOSE\n", "utf8");
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  const store = new EditorStateStore();
  const workspaceSnapshot: EditorSnapshot = {
    ...validSnapshot,
    workspaceFolders: [workspace],
    activeFile: workspaceFile,
  };
  store.connected("mcp-test");
  store.update("mcp-test", workspaceSnapshot);

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
    assert.equal(selection.result?.structuredContent?.restricted, false);

    const beyondEof = await rpc(mcpUrl, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "read_file", arguments: { path: workspaceFile, startLine: 99 } },
    });
    assert.equal(beyondEof.result?.isError, true);
    assert.match(JSON.stringify(beyondEof), /exceeds the file length/i);

    store.update("mcp-test", {
      ...workspaceSnapshot,
      activeFile: outsideFile,
      content: "DO_NOT_EXPOSE",
      selection: {
        text: "DO_NOT_EXPOSE",
        start: { line: 0, character: 0 },
        end: { line: 0, character: 13 },
        isEmpty: false,
        truncated: false,
      },
    });

    const hiddenEditor = await rpc(mcpUrl, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "get_active_editor", arguments: {} },
    });
    assert.equal(hiddenEditor.result?.structuredContent?.activeFile, null);
    assert.equal(hiddenEditor.result?.structuredContent?.content, null);
    assert.equal(hiddenEditor.result?.structuredContent?.restricted, true);
    assert.doesNotMatch(JSON.stringify(hiddenEditor), /DO_NOT_EXPOSE/);

    const hiddenSelection = await rpc(mcpUrl, {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "get_selection", arguments: {} },
    });
    assert.equal(hiddenSelection.result?.structuredContent?.activeFile, null);
    assert.equal(hiddenSelection.result?.structuredContent?.selection, null);
    assert.equal(hiddenSelection.result?.structuredContent?.restricted, true);
    assert.doesNotMatch(JSON.stringify(hiddenSelection), /DO_NOT_EXPOSE/);

    const workspaceView = await rpc(mcpUrl, {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "get_workspace", arguments: {} },
    });
    assert.equal(workspaceView.result?.structuredContent?.activeFile, null);
    assert.doesNotMatch(JSON.stringify(workspaceView), /outside-secret/);
  } finally {
    store.disconnected("mcp-test");
    await closeMcp();
    await closeHttpServer(server);
  }
});
