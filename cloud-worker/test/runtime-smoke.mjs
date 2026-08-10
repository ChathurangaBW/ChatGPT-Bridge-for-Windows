import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import WebSocket from "ws";

const baseUrl = (process.env.BRIDGE_SMOKE_URL ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
const mcpResource = `${baseUrl}/mcp`;
const normalizedMcpAccept = "application/json, text/event-stream";
const modernVersion = "2026-07-28";

function b64url(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

async function jsonFetch(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { response, body, text };
}

async function openDeviceSocket(deviceId, deviceSecret) {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/device/connect";
  url.searchParams.set("device_id", deviceId);

  const socket = new WebSocket(url, { headers: { authorization: `Bearer ${deviceSecret}` } });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for agent_ready.")), 5_000);
    socket.once("message", (raw) => {
      clearTimeout(timer);
      resolve(JSON.parse(raw.toString("utf8")));
    });
  });
  assert.equal(ready.type, "agent_ready");
  assert.equal(ready.deviceId, deviceId);
  return socket;
}

async function authorizeCode(clientId, pairingCode, challenge, state) {
  const authorize = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: "http://127.0.0.1:8788/callback",
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "bridge:read offline_access",
    state,
    resource: mcpResource,
    pairing_code: pairingCode,
  });
  const response = await fetch(`${baseUrl}/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: authorize,
    redirect: "manual",
  });
  assert.equal(response.status, 302);
  const callback = new URL(response.headers.get("location"));
  assert.equal(callback.searchParams.get("state"), state);
  assert.equal(callback.searchParams.get("iss"), baseUrl);
  const code = callback.searchParams.get("code");
  assert.ok(code);
  return code;
}

function tokenBody(code, clientId, verifier) {
  return new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    redirect_uri: "http://127.0.0.1:8788/callback",
    code_verifier: verifier,
    resource: mcpResource,
  });
}

async function exchangeCode(code, clientId, verifier) {
  return jsonFetch("/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: tokenBody(code, clientId, verifier),
  });
}

async function exerciseLegacyRelay(socket, accessToken, accept, id) {
  const relayHandled = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for legacy relayed MCP request with Accept ${accept}.`)), 8_000);
    socket.once("message", (raw) => {
      clearTimeout(timer);
      const request = JSON.parse(raw.toString("utf8"));
      assert.equal(request.type, "mcp_request");
      assert.equal(request.method, "POST");
      assert.equal(request.headers.accept, normalizedMcpAccept);
      assert.equal(request.headers["mcp-method"], "tools/list");
      const rpc = JSON.parse(request.body);
      assert.equal(rpc.method, "tools/list");
      socket.send(JSON.stringify({
        type: "mcp_response",
        requestId: request.requestId,
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { tools: [] } }),
      }));
      resolve();
    });
  });

  const mcpResponsePromise = fetch(mcpResource, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      accept,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list", params: {} }),
  });
  const [mcpResponse] = await Promise.all([mcpResponsePromise, relayHandled]);
  assert.equal(mcpResponse.status, 200);
  assert.deepEqual(await mcpResponse.json(), { jsonrpc: "2.0", id, result: { tools: [] } });
}

async function exerciseModernRelay(socket, accessToken, id) {
  const meta = {
    "io.modelcontextprotocol/protocolVersion": modernVersion,
    "io.modelcontextprotocol/clientInfo": { name: "cloud-smoke", version: "1.0.0" },
    "io.modelcontextprotocol/clientCapabilities": {},
  };
  const relayHandled = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for modern relayed MCP request.")), 8_000);
    socket.once("message", (raw) => {
      clearTimeout(timer);
      const request = JSON.parse(raw.toString("utf8"));
      assert.equal(request.type, "mcp_request");
      assert.equal(request.headers.accept, normalizedMcpAccept);
      assert.equal(request.headers["mcp-protocol-version"], modernVersion);
      assert.equal(request.headers["mcp-method"], "tools/call");
      assert.equal(request.headers["mcp-name"], "get_workspace");
      assert.equal(request.headers["mcp-param-tenant"], "tenant-123");
      const rpc = JSON.parse(request.body);
      assert.equal(rpc.method, "tools/call");
      assert.equal(rpc.params.name, "get_workspace");
      socket.send(JSON.stringify({
        type: "mcp_response",
        requestId: request.requestId,
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: rpc.id,
          result: { resultType: "complete", content: [], structuredContent: { vscodeConnected: true } },
        }),
      }));
      resolve();
    });
  });

  const responsePromise = fetch(mcpResource, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json; charset=utf-8",
      accept: "*/*",
      "mcp-param-tenant": "tenant-123",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "get_workspace", arguments: {}, _meta: meta },
    }),
  });
  const [response] = await Promise.all([responsePromise, relayHandled]);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.result?.structuredContent?.vscodeConnected, true);
}

async function main() {
  const health = await jsonFetch("/health");
  assert.equal(health.response.status, 200);
  assert.equal(health.body.ok, true);

  const protectedMetadata = await jsonFetch("/.well-known/oauth-protected-resource");
  assert.equal(protectedMetadata.response.status, 200);
  assert.equal(protectedMetadata.body.resource, mcpResource);

  const authMetadata = await jsonFetch("/.well-known/oauth-authorization-server");
  assert.equal(authMetadata.response.status, 200);
  assert.equal(authMetadata.body.registration_endpoint, `${baseUrl}/register`);
  assert.ok(authMetadata.body.scopes_supported.includes("offline_access"));

  const unauthenticatedMcp = await fetch(mcpResource, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  assert.equal(unauthenticatedMcp.status, 401);
  assert.match(unauthenticatedMcp.headers.get("www-authenticate") ?? "", /resource_metadata=/i);

  const registration = await jsonFetch("/device/register", { method: "POST" });
  assert.equal(registration.response.status, 201);
  const { deviceId, deviceSecret, pairingCode } = registration.body;
  assert.match(deviceId, /^dev_/);
  assert.equal(typeof deviceSecret, "string");
  assert.match(pairingCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);

  const socket = await openDeviceSocket(deviceId, deviceSecret);
  try {
    const status = await jsonFetch(`/device/status?device_id=${encodeURIComponent(deviceId)}`, {
      headers: { authorization: `Bearer ${deviceSecret}` },
    });
    assert.equal(status.response.status, 200);
    assert.equal(status.body.connected, true);
    assert.equal(status.body.pairingCode, pairingCode);

    const clientRegistration = await jsonFetch("/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "ChatGPT Bridge CI smoke",
        application_type: "native",
        redirect_uris: ["http://127.0.0.1:8788/callback"],
        token_endpoint_auth_method: "none",
      }),
    });
    assert.equal(clientRegistration.response.status, 201);
    const clientId = clientRegistration.body.client_id;
    assert.match(clientId, /^client_/);

    const verifier = b64url(randomBytes(48));
    const challenge = b64url(createHash("sha256").update(verifier).digest());
    const code = await authorizeCode(clientId, pairingCode, challenge, "smoke-state");
    const token = await exchangeCode(code, clientId, verifier);
    assert.equal(token.response.status, 200);
    assert.equal(token.body.token_type, "Bearer");
    assert.equal(typeof token.body.access_token, "string");
    assert.equal(typeof token.body.refresh_token, "string");

    const replay = await exchangeCode(code, clientId, verifier);
    assert.equal(replay.response.status, 400);
    assert.equal(replay.body.error, "invalid_grant");

    const pairedStatus = await jsonFetch(`/device/status?device_id=${encodeURIComponent(deviceId)}`, {
      headers: { authorization: `Bearer ${deviceSecret}` },
    });
    assert.equal(pairedStatus.body.paired, true);
    assert.equal(pairedStatus.body.pairingCode, pairingCode);

    await exerciseLegacyRelay(socket, token.body.access_token, "application/json, text/event-stream", 7);
    await exerciseLegacyRelay(socket, token.body.access_token, "application/json", 8);
    await exerciseLegacyRelay(socket, token.body.access_token, "text/event-stream", 9);
    await exerciseLegacyRelay(socket, token.body.access_token, "*/*", 10);
    await exerciseModernRelay(socket, token.body.access_token, 11);

    const mismatch = await fetch(mcpResource, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token.body.access_token}`,
        "content-type": "application/json",
        "mcp-protocol-version": modernVersion,
        "mcp-method": "tools/list",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 12,
        method: "tools/call",
        params: {
          name: "get_workspace",
          arguments: {},
          _meta: { "io.modelcontextprotocol/protocolVersion": modernVersion },
        },
      }),
    });
    assert.equal(mismatch.status, 400);
    assert.equal((await mismatch.json()).error?.code, -32020);

    const badMediaType = await fetch(mcpResource, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token.body.access_token}`,
        "content-type": "text/plain; a=application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 13, method: "tools/list", params: {} }),
    });
    assert.equal(badMediaType.status, 415);

    const raceVerifier = b64url(randomBytes(48));
    const raceChallenge = b64url(createHash("sha256").update(raceVerifier).digest());
    const raceCode = await authorizeCode(clientId, pairingCode, raceChallenge, "race-state");
    const [raceA, raceB] = await Promise.all([
      exchangeCode(raceCode, clientId, raceVerifier),
      exchangeCode(raceCode, clientId, raceVerifier),
    ]);
    assert.deepEqual([raceA.response.status, raceB.response.status].sort(), [200, 400]);

    const refreshRequest = () => jsonFetch("/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: token.body.refresh_token,
        client_id: clientId,
        resource: mcpResource,
        scope: "bridge:read offline_access",
      }),
    });
    const [refreshA, refreshB] = await Promise.all([refreshRequest(), refreshRequest()]);
    assert.deepEqual([refreshA.response.status, refreshB.response.status].sort(), [200, 400]);
    const refreshed = refreshA.response.status === 200 ? refreshA : refreshB;
    assert.equal(typeof refreshed.body.access_token, "string");
    assert.equal(typeof refreshed.body.refresh_token, "string");
    assert.notEqual(refreshed.body.refresh_token, token.body.refresh_token);
  } finally {
    socket.close(1000, "smoke complete");
  }

  console.log("Cloud relay runtime smoke passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
