import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import WebSocket from "ws";

const baseUrl = (process.env.BRIDGE_SMOKE_URL ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
const mcpResource = `${baseUrl}/mcp`;

function b64url(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

async function jsonFetch(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { response, body };
}

function nextMessage(socket, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for WebSocket message.")), timeoutMs);
    socket.once("message", (raw) => {
      clearTimeout(timer);
      resolve(JSON.parse(raw.toString("utf8")));
    });
  });
}

async function openSocket(deviceId, deviceSecret) {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/device/connect";
  url.searchParams.set("device_id", deviceId);
  const socket = new WebSocket(url, { headers: { authorization: `Bearer ${deviceSecret}` } });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const ready = await nextMessage(socket);
  assert.equal(ready.type, "agent_ready");
  return socket;
}

async function getAccessToken(pairingCode) {
  const registration = await jsonFetch("/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "VSIX multi-window smoke",
      redirect_uris: ["http://127.0.0.1:8789/callback"],
      token_endpoint_auth_method: "none",
    }),
  });
  assert.equal(registration.response.status, 201);
  const clientId = registration.body.client_id;
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const authorize = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: "http://127.0.0.1:8789/callback",
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "bridge:read offline_access",
    state: "multi-window",
    resource: mcpResource,
    pairing_code: pairingCode,
  });
  const authResponse = await fetch(`${baseUrl}/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: authorize,
    redirect: "manual",
  });
  assert.equal(authResponse.status, 302);
  const code = new URL(authResponse.headers.get("location")).searchParams.get("code");
  assert.ok(code);
  const token = await jsonFetch("/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: "http://127.0.0.1:8789/callback",
      code_verifier: verifier,
      resource: mcpResource,
    }),
  });
  assert.equal(token.response.status, 200);
  return token.body.access_token;
}

async function routeRequest(expectedSocket, unexpectedSocket, accessToken, id) {
  let unexpected = false;
  const unexpectedListener = () => { unexpected = true; };
  unexpectedSocket.once("message", unexpectedListener);
  const relayed = nextMessage(expectedSocket, 8000);
  const responsePromise = fetch(mcpResource, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/list",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/list",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "multi-window-smoke", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  const request = await relayed;
  assert.equal(request.type, "mcp_request");
  expectedSocket.send(JSON.stringify({
    type: "mcp_response",
    requestId: request.requestId,
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ jsonrpc: "2.0", id, result: { resultType: "complete", tools: [], ttlMs: 1000, cacheScope: "public" } }),
  }));
  const response = await responsePromise;
  assert.equal(response.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 100));
  unexpectedSocket.off("message", unexpectedListener);
  assert.equal(unexpected, false, "MCP request was routed to the wrong VS Code window.");
}

async function main() {
  const registration = await jsonFetch("/device/register", { method: "POST" });
  assert.equal(registration.response.status, 201);
  const { deviceId, deviceSecret, pairingCode } = registration.body;
  const socketA = await openSocket(deviceId, deviceSecret);
  const socketB = await openSocket(deviceId, deviceSecret);
  try {
    const accessToken = await getAccessToken(pairingCode);

    socketA.send(JSON.stringify({ type: "agent_focus", windowId: "window-a", focusedAt: Date.now() }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    await routeRequest(socketA, socketB, accessToken, "focus-a");

    socketB.send(JSON.stringify({ type: "agent_focus", windowId: "window-b", focusedAt: Date.now() }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    await routeRequest(socketB, socketA, accessToken, "focus-b");
  } finally {
    socketA.close(1000, "smoke complete");
    socketB.close(1000, "smoke complete");
  }
  console.log("Multi-window focus routing smoke passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
