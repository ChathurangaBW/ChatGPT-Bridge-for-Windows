import { MCP_SCOPE, OFFLINE_SCOPE, MAX_MCP_BODY_BYTES, normalizeScope, type CloudMcpRequest } from "./protocol.js";
import { randomId } from "./crypto.js";
import { ControlPlane } from "./controlPlane.js";
import { DeviceRelay } from "./deviceRelay.js";

export { ControlPlane, DeviceRelay };

interface Env {
  CONTROL: DurableObjectNamespace<ControlPlane>;
  DEVICES: DurableObjectNamespace<DeviceRelay>;
}

interface AuthorizeParams {
  responseType: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string;
  state: string;
  resource: string;
}

const MAX_OAUTH_BODY_BYTES = 64 * 1024;
const MCP_POST_ACCEPT = "application/json, text/event-stream";
const SAFE_REQUEST_HEADERS = ["content-type", "accept", "mcp-protocol-version", "mcp-session-id", "last-event-id"];
const SAFE_RESPONSE_HEADERS = ["content-type", "mcp-session-id", "cache-control"];

function control(env: Env) {
  return env.CONTROL.getByName("global");
}

function requestIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

function json(data: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  return new Response(JSON.stringify(data), { status, headers });
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const map: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return map[character] ?? character;
  });
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

async function readBoundedText(request: Request, maxBytes: number): Promise<string> {
  const declared = request.headers.get("content-length");
  if (declared) {
    const size = Number(declared);
    if (Number.isFinite(size) && size > maxBytes) throw new Error("request_body_too_large");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) throw new Error("request_body_too_large");
  return text;
}

function protectedResourceMetadata(origin: string) {
  return {
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    scopes_supported: [MCP_SCOPE],
    bearer_methods_supported: ["header"],
  };
}

function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    registration_endpoint: `${origin}/register`,
    scopes_supported: [MCP_SCOPE, OFFLINE_SCOPE],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  };
}

function oauthError(error: string, description: string, status = 400): Response {
  return json({ error, error_description: description }, status);
}

function unauthorized(origin: string): Response {
  return json(
    { error: "authorization_required" },
    401,
    {
      "www-authenticate": `Bearer realm="chatgpt-bridge", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="${MCP_SCOPE}"`,
    },
  );
}

function readAuthorizeParams(values: URLSearchParams): AuthorizeParams {
  return {
    responseType: values.get("response_type") ?? "",
    clientId: values.get("client_id") ?? "",
    redirectUri: values.get("redirect_uri") ?? "",
    codeChallenge: values.get("code_challenge") ?? "",
    codeChallengeMethod: values.get("code_challenge_method") ?? "",
    scope: normalizeScope(values.get("scope")),
    state: values.get("state") ?? "",
    resource: values.get("resource") ?? "",
  };
}

async function validateAuthorizeParams(params: AuthorizeParams, origin: string, env: Env): Promise<string | null> {
  if (params.responseType !== "code") return "Only response_type=code is supported.";
  if (!params.clientId || !params.redirectUri) return "client_id and redirect_uri are required.";
  if (params.codeChallengeMethod !== "S256" || params.codeChallenge.length < 43) return "PKCE S256 is required.";
  if (params.resource !== `${origin}/mcp`) return "The OAuth resource must be this server's /mcp endpoint.";
  const client = await control(env).getClient(params.clientId);
  if (!client || !client.redirectUris.includes(params.redirectUri)) return "Unknown OAuth client or redirect URI.";
  return null;
}

function authorizationPage(params: AuthorizeParams, pairingCode: string, error?: string): Response {
  const hidden: Array<[string, string]> = [
    ["response_type", params.responseType],
    ["client_id", params.clientId],
    ["redirect_uri", params.redirectUri],
    ["code_challenge", params.codeChallenge],
    ["code_challenge_method", params.codeChallengeMethod],
    ["scope", params.scope],
    ["state", params.state],
    ["resource", params.resource],
  ];
  const hiddenFields = hidden
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
    .join("\n");

  return html(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect ChatGPT Bridge</title>
<style>
body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:560px;margin:64px auto;padding:0 20px;color:#171717}main{border:1px solid #ddd;border-radius:14px;padding:28px}label{display:block;font-weight:650;margin:20px 0 8px}input[type=text]{box-sizing:border-box;width:100%;font:600 22px ui-monospace,Consolas,monospace;letter-spacing:.08em;padding:12px;border:1px solid #aaa;border-radius:8px;text-transform:uppercase}button{margin-top:18px;width:100%;padding:12px;border:0;border-radius:8px;background:#111;color:#fff;font-weight:650;font-size:16px}.error{background:#fff0f0;border:1px solid #e7aaaa;padding:10px;border-radius:8px}p{line-height:1.5;color:#444}</style>
</head>
<body><main><h1>Connect ChatGPT Bridge</h1><p>Enter the pairing code shown by <strong>ChatGPTBridge.exe</strong> on this PC. This authorizes ChatGPT to use only the paired Windows bridge.</p>
${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
<form method="post" action="/authorize">${hiddenFields}<label for="pairing_code">Pairing code</label><input id="pairing_code" name="pairing_code" type="text" autocomplete="one-time-code" spellcheck="false" value="${escapeHtml(pairingCode)}" placeholder="ABCD-EFGH-JKLM" required><button type="submit">Authorize this PC</button></form></main></body></html>`);
}

async function handleRegister(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
  let body: unknown;
  try {
    body = JSON.parse(await readBoundedText(request, MAX_OAUTH_BODY_BYTES));
  } catch (error) {
    if (error instanceof Error && error.message === "request_body_too_large") {
      return oauthError("invalid_client_metadata", "Registration request is too large.", 413);
    }
    return oauthError("invalid_client_metadata", "Request body must be JSON.");
  }
  const input = body as { redirect_uris?: unknown; client_name?: unknown; token_endpoint_auth_method?: unknown };
  if (!Array.isArray(input.redirect_uris) || !input.redirect_uris.every((value) => typeof value === "string")) {
    return oauthError("invalid_redirect_uri", "redirect_uris must be an array of URLs.");
  }
  if (input.token_endpoint_auth_method !== undefined && input.token_endpoint_auth_method !== "none") {
    return oauthError("invalid_client_metadata", "Only public OAuth clients using token_endpoint_auth_method=none are supported.");
  }
  try {
    const client = await control(env).registerClient(
      {
        redirectUris: input.redirect_uris,
        ...(typeof input.client_name === "string" ? { clientName: input.client_name } : {}),
      },
      requestIp(request),
    );
    return json(
      {
        client_id: client.clientId,
        client_id_issued_at: Math.floor(client.createdAt / 1000),
        redirect_uris: client.redirectUris,
        client_name: client.clientName,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      201,
    );
  } catch (error) {
    return oauthError("invalid_client_metadata", error instanceof Error ? error.message : "Client registration failed.");
  }
}

async function handleAuthorize(request: Request, origin: string, env: Env): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: { allow: "GET, POST" } });
  }
  let values: URLSearchParams;
  try {
    values = request.method === "POST" ? new URLSearchParams(await readBoundedText(request, MAX_OAUTH_BODY_BYTES)) : new URL(request.url).searchParams;
  } catch {
    return html("<h1>Authorization request rejected</h1><p>Request body is too large.</p>", 413);
  }
  const params = readAuthorizeParams(values);
  const validationError = await validateAuthorizeParams(params, origin, env);
  if (validationError) return html(`<h1>Authorization request rejected</h1><p>${escapeHtml(validationError)}</p>`, 400);

  const pairingCode = values.get("pairing_code") ?? "";
  if (request.method !== "POST") return authorizationPage(params, pairingCode);

  try {
    const code = await control(env).authorize({
      pairingCode,
      clientId: params.clientId,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      scope: params.scope,
      resource: params.resource,
    });
    const redirect = new URL(params.redirectUri);
    redirect.searchParams.set("code", code);
    if (params.state) redirect.searchParams.set("state", params.state);
    return Response.redirect(redirect.toString(), 302);
  } catch (error) {
    return authorizationPage(params, pairingCode, error instanceof Error ? error.message : "Authorization failed.");
  }
}

async function handleToken(request: Request, origin: string, env: Env): Promise<Response> {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
  let values: URLSearchParams;
  try {
    values = new URLSearchParams(await readBoundedText(request, MAX_OAUTH_BODY_BYTES));
  } catch {
    return oauthError("invalid_request", "Token request is too large.", 413);
  }
  const grantType = values.get("grant_type") ?? "";
  const clientId = values.get("client_id") ?? "";
  const resource = values.get("resource") ?? "";
  if (!clientId || resource !== `${origin}/mcp`) return oauthError("invalid_request", "client_id and the canonical MCP resource are required.");

  try {
    const tokens =
      grantType === "authorization_code"
        ? await control(env).exchangeAuthorizationCode({
            code: values.get("code") ?? "",
            clientId,
            redirectUri: values.get("redirect_uri") ?? "",
            codeVerifier: values.get("code_verifier") ?? "",
            resource,
          })
        : grantType === "refresh_token"
          ? await control(env).refresh({
              refreshToken: values.get("refresh_token") ?? "",
              clientId,
              resource,
              ...(values.get("scope") ? { scope: values.get("scope")! } : {}),
            })
          : null;
    if (!tokens) return oauthError("unsupported_grant_type", "Only authorization_code and refresh_token are supported.");
    return json({
      access_token: tokens.accessToken,
      token_type: "Bearer",
      expires_in: tokens.expiresIn,
      scope: tokens.scope,
      ...(tokens.refreshToken ? { refresh_token: tokens.refreshToken } : {}),
    });
  } catch (error) {
    return oauthError("invalid_grant", error instanceof Error ? error.message : "Token exchange failed.");
  }
}

async function handleDeviceRegister(request: Request, origin: string, env: Env): Promise<Response> {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
  try {
    return json(await control(env).registerDevice(origin, requestIp(request)), 201);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Device registration failed." }, 429);
  }
}

async function requireDevice(request: Request, env: Env): Promise<{ deviceId: string; secret: string } | Response> {
  const url = new URL(request.url);
  const deviceId = url.searchParams.get("device_id") ?? "";
  const secret = bearerToken(request) ?? "";
  if (!deviceId || !secret || !(await control(env).verifyDevice(deviceId, secret))) {
    return json({ error: "invalid_device_credential" }, 401);
  }
  return { deviceId, secret };
}

async function handleDeviceStatus(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: { allow: "GET" } });
  const auth = await requireDevice(request, env);
  if (auth instanceof Response) return auth;
  try {
    const status = await control(env).getDeviceStatus(auth.deviceId, auth.secret);
    const connected = await env.DEVICES.getByName(auth.deviceId).isConnected();
    return json({ deviceId: auth.deviceId, connected, ...status });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to read device status." }, 400);
  }
}

async function handleRotatePairing(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
  const auth = await requireDevice(request, env);
  if (auth instanceof Response) return auth;
  try {
    return json(await control(env).rotatePairing(auth.deviceId, auth.secret));
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to rotate pairing code." }, 400);
  }
}

async function handleDeviceConnect(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected WebSocket", { status: 426 });
  }
  const auth = await requireDevice(request, env);
  if (auth instanceof Response) return auth;
  const headers = new Headers(request.headers);
  headers.set("X-Bridge-Device-Id", auth.deviceId);
  headers.delete("Authorization");
  const internalRequest = new Request("https://device.internal/connect", { method: "GET", headers });
  return env.DEVICES.getByName(auth.deviceId).fetch(internalRequest);
}

async function handleMcp(request: Request, origin: string, env: Env): Promise<Response> {
  if (request.method !== "POST" && request.method !== "DELETE") {
    return new Response("Method not allowed", { status: 405, headers: { allow: "POST, DELETE" } });
  }
  if (request.method === "POST") {
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("application/json")) return json({ error: "MCP POST requests must use application/json." }, 415);
  }
  const token = bearerToken(request);
  if (!token) return unauthorized(origin);
  const resource = `${origin}/mcp`;
  const auth = await control(env).introspectAccessToken(token, resource);
  if (!auth) return unauthorized(origin);

  let body = "";
  try {
    body = request.method === "POST" ? await readBoundedText(request, MAX_MCP_BODY_BYTES) : "";
  } catch {
    return json({ error: "MCP request body is too large." }, 413);
  }

  const headers: Record<string, string> = {};
  for (const name of SAFE_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value && value.length <= 4096) headers[name] = value;
  }
  if (request.method === "POST") {
    // The local MCP transport follows the spec strictly and requires both media types.
    // Normalize the trusted internal hop so ChatGPT tool discovery remains compatible
    // even when the public caller sends a narrower HTTP Accept value.
    headers.accept = MCP_POST_ACCEPT;
  }
  const relayRequest: CloudMcpRequest = {
    type: "mcp_request",
    requestId: randomId("rpc"),
    method: request.method as "POST" | "DELETE",
    headers,
    body,
  };

  try {
    const response = await env.DEVICES.getByName(auth.deviceId).forwardMcp(relayRequest);
    const responseHeaders = new Headers();
    for (const name of SAFE_RESPONSE_HEADERS) {
      const value = response.headers[name];
      if (value) responseHeaders.set(name, value);
    }
    if (!responseHeaders.has("content-type")) responseHeaders.set("content-type", "application/json; charset=utf-8");
    responseHeaders.set("cache-control", "no-store");
    responseHeaders.set("x-content-type-options", "nosniff");
    return new Response(response.body, { status: response.status, headers: responseHeaders });
  } catch (error) {
    return json(
      {
        jsonrpc: "2.0",
        error: { code: -32001, message: error instanceof Error ? error.message : "Windows bridge unavailable." },
        id: null,
      },
      503,
    );
  }
}

function pairingInfoPage(code: string): Response {
  return html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ChatGPT Bridge Pairing</title></head><body><main style="font-family:system-ui;max-width:560px;margin:64px auto;padding:20px"><h1>ChatGPT Bridge pairing</h1><p>Pairing code:</p><p style="font:700 28px ui-monospace,Consolas,monospace">${escapeHtml(code)}</p><p>In ChatGPT, connect the ChatGPT Bridge app. When the authorization page opens, enter this code. No OpenAI API key is required on this PC.</p></main></body></html>`);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = url.origin;

    if (url.pathname === "/health") return json({ ok: true, service: "chatgpt-bridge-cloud", version: "0.2.0" });
    if (url.pathname === "/.well-known/oauth-protected-resource" || url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      return json(protectedResourceMetadata(origin));
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") return json(authorizationServerMetadata(origin));
    if (url.pathname === "/register") return handleRegister(request, env);
    if (url.pathname === "/authorize") return handleAuthorize(request, origin, env);
    if (url.pathname === "/token") return handleToken(request, origin, env);
    if (url.pathname === "/device/register") return handleDeviceRegister(request, origin, env);
    if (url.pathname === "/device/status") return handleDeviceStatus(request, env);
    if (url.pathname === "/device/pairing") return handleRotatePairing(request, env);
    if (url.pathname === "/device/connect") return handleDeviceConnect(request, env);
    if (url.pathname === "/mcp") return handleMcp(request, origin, env);
    if (request.method === "GET" && url.pathname.startsWith("/pair/")) return pairingInfoPage(decodeURIComponent(url.pathname.slice(6)));
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
