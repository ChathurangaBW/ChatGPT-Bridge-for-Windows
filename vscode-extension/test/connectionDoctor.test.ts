import assert from "node:assert/strict";
import test from "node:test";
import { BRIDGE_ORIGIN, runBridgeDiagnostics } from "../src/connectionDoctor.js";

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function healthyFetch(options?: { missingIssuer?: boolean; anonymousMcp?: boolean }): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = new URL(url).pathname;
    if (path === "/health") {
      return jsonResponse({ ok: true, service: "chatgpt-bridge-cloud", version: "0.2.0" });
    }
    if (path === "/.well-known/oauth-protected-resource/mcp") {
      return jsonResponse({
        resource: `${BRIDGE_ORIGIN}/mcp`,
        authorization_servers: [BRIDGE_ORIGIN],
        scopes_supported: ["bridge:read"],
      });
    }
    if (path === "/.well-known/oauth-authorization-server") {
      return jsonResponse({
        issuer: BRIDGE_ORIGIN,
        authorization_endpoint: `${BRIDGE_ORIGIN}/authorize`,
        token_endpoint: `${BRIDGE_ORIGIN}/token`,
        registration_endpoint: `${BRIDGE_ORIGIN}/register`,
        scopes_supported: ["bridge:read", "offline_access"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    }
    if (path === "/register") {
      return jsonResponse({ client_id: "client_doctor" }, 201);
    }
    if (path === "/authorize") {
      const body = init?.body instanceof URLSearchParams ? init.body : new URLSearchParams(String(init?.body ?? ""));
      const callback = new URL("http://127.0.0.1:8792/callback");
      callback.searchParams.set("code", "doctor-code");
      callback.searchParams.set("state", body.get("state") ?? "");
      if (!options?.missingIssuer) callback.searchParams.set("iss", BRIDGE_ORIGIN);
      return new Response(null, { status: 302, headers: { location: callback.toString() } });
    }
    if (path === "/mcp") {
      if (options?.anonymousMcp) return jsonResponse({ tools: [] }, 200);
      return jsonResponse(
        { error: "authorization_required" },
        401,
        { "www-authenticate": `Bearer resource_metadata="${BRIDGE_ORIGIN}/.well-known/oauth-protected-resource/mcp"` },
      );
    }
    return new Response("Not found", { status: 404 });
  }) as typeof fetch;
}

test("connection doctor passes a current Bridge runtime", async () => {
  const result = await runBridgeDiagnostics(healthyFetch(), BRIDGE_ORIGIN, "ABCD-EFGH-JKLM");
  assert.equal(result.ok, true);
  assert.equal(result.checks.length, 5);
  assert.deepEqual(result.checks.map((check) => check.state), ["pass", "pass", "pass", "pass", "pass"]);
});

test("connection doctor detects the stale OAuth redirect seen in deployment", async () => {
  const result = await runBridgeDiagnostics(healthyFetch({ missingIssuer: true }), BRIDGE_ORIGIN, "ABCD-EFGH-JKLM");
  assert.equal(result.ok, false);
  const redirect = result.checks.find((check) => check.id === "oauth-redirect");
  assert.equal(redirect?.state, "fail");
  assert.match(redirect?.detail ?? "", /Worker update required/i);
});

test("connection doctor rejects anonymously exposed MCP tools", async () => {
  const result = await runBridgeDiagnostics(healthyFetch({ anonymousMcp: true }), BRIDGE_ORIGIN, "ABCD-EFGH-JKLM");
  assert.equal(result.ok, false);
  const mcp = result.checks.find((check) => check.id === "mcp-challenge");
  assert.equal(mcp?.state, "fail");
  assert.match(mcp?.detail ?? "", /Expected OAuth HTTP 401/i);
});
