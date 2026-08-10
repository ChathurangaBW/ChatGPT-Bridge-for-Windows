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
        redirect_uris: ["http://127.0.0.1:8788/callback"],
        token_endpoint_auth_method: "none",
      }),
    });
    assert.equal(clientRegistration.response.status, 201);
    const clientId = clientRegistration.body.client_id;
    assert.match(clientId, /^client_/);

    const verifier = b64url(randomBytes(48));
    const challenge = b64url(createHash("sha256").update(verifier).digest());
    const authorize = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: "http://127.0.0.1:8788/callback",
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "bridge:read offline_access",
      state: "smoke-state",
      resource: mcpResource,
      pairing_code: pairingCode,
    });
    const authorizeResponse = await fetch(`${baseUrl}/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: authorize,
      redirect: "manual",
    });
    assert.equal(authorizeResponse.status, 302);
    const callback = new URL(authorizeResponse.headers.get("location"));
    assert.equal(callback.searchParams.get("state"), "smoke-state");
    const code = callback.searchParams.get("code");
    assert.ok(code);

    const token = await jsonFetch("/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        redirect_uri: "http://127.0.0.1:8788/callback",
        code_verifier: verifier,
        resource: mcpResource,
      }),
    });
    assert.equal(token.response.status, 200);
    assert.equal(token.body.token_type, "Bearer");
    assert.equal(typeof token.body.access_token, "string");
    assert.equal(typeof token.body.refresh_token, "string");

    const pairedStatus = await jsonFetch(`/device/status?device_id=${encodeURIComponent(deviceId)}`, {
      headers: { authorization: `Bearer ${deviceSecret}` },
    });
    assert.equal(pairedStatus.body.paired, true);
    assert.equal(pairedStatus.body.pairingCode, pairingCode);

    const relayHandled = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for relayed MCP request.")), 8_000);
      socket.once("message", (raw) => {
        clearTimeout(timer);
        const request = JSON.parse(raw.toString("utf8"));
        assert.equal(request.type, "mcp_request");
        assert.equal(request.method, "POST");
        const rpc = JSON.parse(request.body);
        assert.equal(rpc.method, "tools/list");
        socket.send(
          JSON.stringify({
            type: "mcp_response",
            requestId: request.requestId,
            status: 200,
            headers: { "content-type": "application/json; charset=utf-8" },
            body: JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { tools: [] } }),
          }),
        );
        resolve();
      });
    });

    const mcpResponsePromise = fetch(mcpResource, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token.body.access_token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list", params: {} }),
    });
    const [mcpResponse] = await Promise.all([mcpResponsePromise, relayHandled]);
    assert.equal(mcpResponse.status, 200);
    assert.deepEqual(await mcpResponse.json(), { jsonrpc: "2.0", id: 7, result: { tools: [] } });

    const refresh = await jsonFetch("/token", {
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
    assert.equal(refresh.response.status, 200);
    assert.equal(typeof refresh.body.access_token, "string");
    assert.equal(typeof refresh.body.refresh_token, "string");
    assert.notEqual(refresh.body.refresh_token, token.body.refresh_token);
  } finally {
    socket.close(1000, "smoke complete");
  }

  console.log("Cloud relay runtime smoke passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
