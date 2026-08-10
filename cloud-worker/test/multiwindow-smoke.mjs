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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function mcpFetch(accessToken, id) {
  return fetch(mcpResource, {
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
}

function sendSuccess(socket, request, id) {
  socket.send(JSON.stringify({
    type: "mcp_response",
    requestId: request.requestId,
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ jsonrpc: "2.0", id, result: { resultType: "complete", tools: [], ttlMs: 1000, cacheScope: "public" } }),
  }));
}

async function routeRequest(expectedSocket, unexpectedSockets, accessToken, id) {
  const unexpected = new Set();
  const listeners = unexpectedSockets.map((socket) => {
    const listener = () => unexpected.add(socket);
    socket.once("message", listener);
    return { socket, listener };
  });
  try {
    const relayed = nextMessage(expectedSocket, 8000);
    const responsePromise = mcpFetch(accessToken, id);
    const request = await relayed;
    assert.equal(request.type, "mcp_request");
    sendSuccess(expectedSocket, request, id);
    const response = await responsePromise;
    assert.equal(response.status, 200);
    await delay(100);
    assert.equal(unexpected.size, 0, "MCP request was routed to the wrong VS Code window.");
  } finally {
    for (const { socket, listener } of listeners) socket.off("message", listener);
  }
}

async function inFlightFocusChange(socketA, socketB, accessToken) {
  socketA.send(JSON.stringify({ type: "agent_focus", windowId: "window-a", focusedAt: Date.now() }));
  await delay(100);

  const relayed = nextMessage(socketA, 8000);
  let settled = false;
  const responsePromise = mcpFetch(accessToken, "in-flight").then((response) => {
    settled = true;
    return response;
  });
  const request = await relayed;

  socketB.send(JSON.stringify({ type: "agent_focus", windowId: "window-b", focusedAt: Date.now() }));
  await delay(100);
  socketB.send(JSON.stringify({
    type: "mcp_response",
    requestId: request.requestId,
    status: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "in-flight", result: { wrongWindow: true } }),
  }));
  await delay(150);
  assert.equal(settled, false, "A stale/wrong socket resolved an in-flight MCP request.");

  sendSuccess(socketA, request, "in-flight");
  const response = await responsePromise;
  assert.equal(response.status, 200);
  assert.equal((await response.json()).result.tools.length, 0);
}

async function main() {
  const registration = await jsonFetch("/device/register", { method: "POST" });
  assert.equal(registration.response.status, 201);
  const { deviceId, deviceSecret, pairingCode } = registration.body;

  const socketA = await openSocket(deviceId, deviceSecret);
  socketA.send(JSON.stringify({ type: "agent_focus", windowId: "window-a", focusedAt: Date.now() }));
  await delay(100);

  // A newly opened background sibling must not steal routing from explicitly focused A.
  const socketB = await openSocket(deviceId, deviceSecret);
  try {
    assert.equal(socketA.readyState, WebSocket.OPEN);
    assert.equal(socketB.readyState, WebSocket.OPEN);
    const accessToken = await getAccessToken(pairingCode);

    await routeRequest(socketA, [socketB], accessToken, "background-b-does-not-steal");

    socketB.send(JSON.stringify({ type: "agent_focus", windowId: "window-b", focusedAt: Date.now() }));
    await delay(100);
    await routeRequest(socketB, [socketA], accessToken, "focus-b");

    // Rapid focus sequence should deterministically end at A.
    socketA.send(JSON.stringify({ type: "agent_focus", windowId: "window-a", focusedAt: Date.now() }));
    await delay(25);
    socketB.send(JSON.stringify({ type: "agent_focus", windowId: "window-b", focusedAt: Date.now() }));
    await delay(25);
    socketA.send(JSON.stringify({ type: "agent_focus", windowId: "window-a", focusedAt: Date.now() }));
    await delay(100);
    await routeRequest(socketA, [socketB], accessToken, "rapid-focus-a");

    await inFlightFocusChange(socketA, socketB, accessToken);

    // Unknown, invalid and binary responses must not disturb future routing.
    socketB.send(JSON.stringify({ type: "mcp_response", requestId: "unknown", status: 200, headers: {}, body: "{}" }));
    socketB.send("not-json");
    socketB.send(Buffer.from(JSON.stringify({ type: "mcp_response", requestId: "binary", status: 200, headers: {}, body: "{}" })));
    await delay(100);
    await routeRequest(socketB, [socketA], accessToken, "after-invalid-responses");

    // Closing the focused window falls back to the remaining live sibling.
    await new Promise((resolve) => {
      socketB.once("close", resolve);
      socketB.close(1000, "close focused window");
    });
    await delay(100);
    await routeRequest(socketA, [], accessToken, "fallback-after-close");
  } finally {
    if (socketA.readyState === WebSocket.OPEN) socketA.close(1000, "smoke complete");
    if (socketB.readyState === WebSocket.OPEN) socketB.close(1000, "smoke complete");
  }
  console.log("Multi-window focus routing smoke passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
