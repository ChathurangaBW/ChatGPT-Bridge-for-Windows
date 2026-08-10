import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import WebSocket from "ws";

const baseUrl = (process.env.BRIDGE_SMOKE_URL ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
const resource = `${baseUrl}/mcp`;

function b64url(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

async function response(path, init = {}) {
  return fetch(`${baseUrl}${path}`, init);
}

async function json(path, init = {}) {
  const res = await response(path, init);
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { response: res, body, text };
}

async function registerDevice() {
  const result = await json("/device/register", { method: "POST" });
  assert.equal(result.response.status, 201);
  assert.match(result.body.deviceId, /^dev_/);
  assert.match(result.body.deviceSecret, /^[A-Za-z0-9_-]{40,}$/);
  assert.match(result.body.pairingCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  return result.body;
}

async function registerClient(port = 8791) {
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const result = await json("/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Bridge security smoke", redirect_uris: [redirectUri], token_endpoint_auth_method: "none" }),
  });
  assert.equal(result.response.status, 201);
  return { clientId: result.body.client_id, redirectUri };
}

function pkce() {
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

async function authorize({ clientId, redirectUri, pairingCode, challenge, scope = "bridge:read offline_access", state = "security" }) {
  const body = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope,
    state,
    resource,
    pairing_code: pairingCode,
  });
  return response("/authorize", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    redirect: "manual",
  });
}

function codeFrom(response) {
  assert.equal(response.status, 302);
  const location = response.headers.get("location");
  assert.ok(location);
  return new URL(location).searchParams.get("code");
}

async function exchange({ code, clientId, redirectUri, verifier, resourceValue = resource }) {
  return json("/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource: resourceValue,
    }),
  });
}

async function refresh({ refreshToken, clientId, scope = "bridge:read offline_access", resourceValue = resource }) {
  return json("/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      resource: resourceValue,
      scope,
    }),
  });
}

async function main() {
  // Strict methods/content types and bounded public bodies.
  assert.equal((await response("/register", { method: "GET" })).status, 405);
  assert.equal((await response("/register", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })).status, 415);
  assert.equal((await response("/register", { method: "POST", headers: { "content-type": "application/json" }, body: "{" })).status, 400);
  assert.equal((await response("/register", { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(70_000) })).status, 413);
  assert.equal((await response("/token", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 415);
  assert.equal((await response("/authorize", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 415);
  assert.equal((await response("/device/register", { method: "POST", body: "unexpected" })).status, 400);
  assert.equal((await response("/device/pairing", { method: "GET" })).status, 405);

  const device = await registerDevice();
  const client = await registerClient();

  // Device control endpoints fail closed and never return the secret.
  const unauthStatus = await json(`/device/status?device_id=${encodeURIComponent(device.deviceId)}`);
  assert.equal(unauthStatus.response.status, 401);
  const badStatus = await json(`/device/status?device_id=${encodeURIComponent(device.deviceId)}`, { headers: { authorization: "Bearer wrong" } });
  assert.equal(badStatus.response.status, 401);
  const goodStatus = await json(`/device/status?device_id=${encodeURIComponent(device.deviceId)}`, { headers: { authorization: `Bearer ${device.deviceSecret}` } });
  assert.equal(goodStatus.response.status, 200);
  assert.equal("deviceSecret" in goodStatus.body, false);
  assert.equal(JSON.stringify(goodStatus.body).includes(device.deviceSecret), false);
  const unauthRotate = await json(`/device/pairing?device_id=${encodeURIComponent(device.deviceId)}`, { method: "POST" });
  assert.equal(unauthRotate.response.status, 401);

  // Invalid bearer and malformed Authorization never expose MCP anonymously.
  for (const authorization of [undefined, "Basic abc", "Bearer wrong"]) {
    const headers = { "content-type": "application/json" };
    if (authorization) headers.authorization = authorization;
    const mcp = await response("/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    assert.equal(mcp.status, 401);
    assert.match(mcp.headers.get("www-authenticate") ?? "", /resource_metadata=/i);
  }

  // PKCE invalid/missing verifier and wrong OAuth context are rejected without consuming a valid code.
  const firstPkce = pkce();
  const auth = await authorize({ clientId: client.clientId, redirectUri: client.redirectUri, pairingCode: device.pairingCode, challenge: firstPkce.challenge });
  const code = codeFrom(auth);
  assert.equal((await exchange({ code, clientId: client.clientId, redirectUri: client.redirectUri, verifier: "" })).response.status, 400);
  assert.equal((await exchange({ code, clientId: client.clientId, redirectUri: client.redirectUri, verifier: b64url(randomBytes(48)) })).response.status, 400);
  assert.equal((await exchange({ code, clientId: "wrong-client", redirectUri: client.redirectUri, verifier: firstPkce.verifier })).response.status, 400);
  assert.equal((await exchange({ code, clientId: client.clientId, redirectUri: "http://127.0.0.1:9999/wrong", verifier: firstPkce.verifier })).response.status, 400);
  assert.equal((await exchange({ code, clientId: client.clientId, redirectUri: client.redirectUri, verifier: firstPkce.verifier, resourceValue: `${baseUrl}/wrong` })).response.status, 400);
  const validAfterBadAttempts = await exchange({ code, clientId: client.clientId, redirectUri: client.redirectUri, verifier: firstPkce.verifier });
  assert.equal(validAfterBadAttempts.response.status, 200);

  // Refresh rotation, replay rejection and scope broadening/context mismatch.
  const refreshToken = validAfterBadAttempts.body.refresh_token;
  assert.equal(typeof refreshToken, "string");
  assert.equal((await refresh({ refreshToken, clientId: "wrong-client" })).response.status, 400);
  assert.equal((await refresh({ refreshToken, clientId: client.clientId, resourceValue: `${baseUrl}/wrong` })).response.status, 400);
  assert.equal((await refresh({ refreshToken, clientId: client.clientId, scope: "bridge:read offline_access admin" })).response.status, 400);
  const narrowed = await refresh({ refreshToken, clientId: client.clientId, scope: "bridge:read" });
  assert.equal(narrowed.response.status, 200);
  assert.equal(narrowed.body.scope, "bridge:read");
  assert.equal(narrowed.body.refresh_token, undefined);
  assert.equal((await refresh({ refreshToken, clientId: client.clientId })).response.status, 400);

  // A stale authorization code must fail after pairing generation rotation; old pairing code must fail, new succeeds.
  const stalePkce = pkce();
  const staleAuth = await authorize({ clientId: client.clientId, redirectUri: client.redirectUri, pairingCode: device.pairingCode, challenge: stalePkce.challenge, state: "stale" });
  const staleCode = codeFrom(staleAuth);
  const rotated = await json(`/device/pairing?device_id=${encodeURIComponent(device.deviceId)}`, {
    method: "POST",
    headers: { authorization: `Bearer ${device.deviceSecret}` },
  });
  assert.equal(rotated.response.status, 200);
  assert.notEqual(rotated.body.pairingCode, device.pairingCode);
  assert.equal((await exchange({ code: staleCode, clientId: client.clientId, redirectUri: client.redirectUri, verifier: stalePkce.verifier })).response.status, 400);

  const oldPairAttempt = await authorize({ clientId: client.clientId, redirectUri: client.redirectUri, pairingCode: device.pairingCode, challenge: pkce().challenge, state: "old-pair" });
  assert.equal(oldPairAttempt.status, 200);
  assert.match(await oldPairAttempt.text(), /invalid|expired|no longer active/i);
  const freshPkce = pkce();
  const newPairAttempt = await authorize({ clientId: client.clientId, redirectUri: client.redirectUri, pairingCode: rotated.body.pairingCode, challenge: freshPkce.challenge, state: "new-pair" });
  assert.equal(newPairAttempt.status, 302);

  // Auth-code and refresh-token races remain single-use under concurrency.
  const raceCode = codeFrom(newPairAttempt);
  const [codeA, codeB] = await Promise.all([
    exchange({ code: raceCode, clientId: client.clientId, redirectUri: client.redirectUri, verifier: freshPkce.verifier }),
    exchange({ code: raceCode, clientId: client.clientId, redirectUri: client.redirectUri, verifier: freshPkce.verifier }),
  ]);
  assert.deepEqual([codeA.response.status, codeB.response.status].sort(), [200, 400]);
  const raceToken = codeA.response.status === 200 ? codeA.body.refresh_token : codeB.body.refresh_token;
  const [refreshA, refreshB] = await Promise.all([
    refresh({ refreshToken: raceToken, clientId: client.clientId }),
    refresh({ refreshToken: raceToken, clientId: client.clientId }),
  ]);
  assert.deepEqual([refreshA.response.status, refreshB.response.status].sort(), [200, 400]);

  // MCP HTTP input hardening with a valid bearer token.
  const activeAccessToken = codeA.response.status === 200 ? codeA.body.access_token : codeB.body.access_token;
  assert.equal((await response("/mcp", { method: "GET" })).status, 405);
  assert.equal((await response("/mcp", { method: "POST", headers: { authorization: `Bearer ${activeAccessToken}`, "content-type": "text/plain" }, body: "{}" })).status, 415);
  assert.equal((await response("/mcp", { method: "POST", headers: { authorization: `Bearer ${activeAccessToken}`, "content-type": "application/json", "mcp-param-": "x" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) })).status, 400);
  assert.equal((await response("/mcp", { method: "POST", headers: { authorization: `Bearer ${activeAccessToken}`, "content-type": "application/json", "mcp-param-large": "x".repeat(5000) }, body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }) })).status, 431);

  const manyHeaders = { authorization: `Bearer ${activeAccessToken}`, "content-type": "application/json" };
  for (let index = 0; index < 50; index += 1) manyHeaders[`mcp-param-h${index}`] = "x";
  assert.equal((await response("/mcp", { method: "POST", headers: manyHeaders, body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list", params: {} }) })).status, 431);

  const mismatch = await response("/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${activeAccessToken}`,
      "content-type": "application/json",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/call",
      "mcp-name": "read_file",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "get_workspace",
        arguments: {},
        _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
      },
    }),
  });
  assert.equal(mismatch.status, 400);
  assert.equal((await mismatch.json()).error.code, -32020);

  // Body > public MCP bound is rejected before relay. No device socket is required for this case.
  const oversizedBody = JSON.stringify({ jsonrpc: "2.0", id: 6, method: "tools/list", params: { pad: "x".repeat(6 * 1024 * 1024 + 1024) } });
  assert.equal((await response("/mcp", { method: "POST", headers: { authorization: `Bearer ${activeAccessToken}`, "content-type": "application/json" }, body: oversizedBody })).status, 413);

  // No generic WebSocket access without a valid device credential.
  const wsUrl = new URL(baseUrl);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  wsUrl.pathname = "/device/connect";
  wsUrl.searchParams.set("device_id", device.deviceId);
  const unauthorizedSocket = new WebSocket(wsUrl);
  const wsOutcome = await new Promise((resolve) => {
    unauthorizedSocket.once("unexpected-response", (_req, res) => resolve(res.statusCode));
    unauthorizedSocket.once("error", () => resolve("error"));
    unauthorizedSocket.once("open", () => resolve("open"));
  });
  assert.notEqual(wsOutcome, "open");

  console.log("Cloud OAuth/device/HTTP security smoke passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
