import baseHandler, { ControlPlane, DeviceRelay } from "./index.js";
import { randomId } from "./crypto.js";
import { MCP_SCOPE, MAX_MCP_BODY_BYTES, type CloudMcpRequest } from "./protocol.js";

export { ControlPlane, DeviceRelay };

interface Env {
  CONTROL: DurableObjectNamespace<ControlPlane>;
  DEVICES: DurableObjectNamespace<DeviceRelay>;
}

interface JsonRpcHints {
  id: unknown;
  method?: string;
  name?: string;
  protocolVersion?: string;
}

const MCP_POST_ACCEPT = "application/json, text/event-stream";
const MAX_FORWARDED_HEADERS = 48;
const MAX_HEADER_NAME_CHARS = 128;
const MAX_HEADER_VALUE_CHARS = 4096;
const MAX_OAUTH_BODY_BYTES = 64 * 1024;
const MAX_DEVICE_CONTROL_BODY_BYTES = 1024;
const STATIC_REQUEST_HEADERS = new Set([
  "content-type",
  "accept",
  "mcp-protocol-version",
  "mcp-session-id",
  "last-event-id",
  "mcp-method",
  "mcp-name",
]);
const SAFE_RESPONSE_HEADERS = ["content-type", "mcp-session-id", "cache-control"];

function control(env: Env) {
  return env.CONTROL.getByName("global");
}

function json(data: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  return new Response(JSON.stringify(data), { status, headers });
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

function mediaType(request: Request): string {
  return (request.headers.get("content-type") ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

async function readBoundedText(request: Request, maxBytes: number): Promise<string> {
  const declared = request.headers.get("content-length");
  if (declared) {
    const size = Number(declared);
    if (Number.isFinite(size) && size > maxBytes) throw new Error("request_body_too_large");
  }
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("request_body_too_large");
        throw new Error("request_body_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
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

function parseJsonRpcHints(body: string): JsonRpcHints {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { id: null };
    const value = parsed as { id?: unknown; method?: unknown; params?: unknown };
    const params = value.params && typeof value.params === "object" && !Array.isArray(value.params)
      ? (value.params as Record<string, unknown>)
      : null;
    const meta = params?._meta && typeof params._meta === "object" && !Array.isArray(params._meta)
      ? (params._meta as Record<string, unknown>)
      : null;
    const principal = typeof params?.name === "string"
      ? params.name
      : typeof params?.uri === "string"
        ? params.uri
        : undefined;
    const protocolVersion = typeof meta?.["io.modelcontextprotocol/protocolVersion"] === "string"
      ? (meta["io.modelcontextprotocol/protocolVersion"] as string)
      : undefined;
    return {
      id: value.id ?? null,
      ...(typeof value.method === "string" ? { method: value.method } : {}),
      ...(principal ? { name: principal } : {}),
      ...(protocolVersion ? { protocolVersion } : {}),
    };
  } catch {
    return { id: null };
  }
}

function headerMismatch(id: unknown, message: string): Response {
  return json({ jsonrpc: "2.0", id: id ?? null, error: { code: -32020, message } }, 400);
}

function isSafeAsciiHeaderValue(value: string): boolean {
  return value.length > 0 && value.length <= MAX_HEADER_VALUE_CHARS && /^[\x20-\x7e]+$/.test(value);
}

function isAllowedRequestHeader(name: string): boolean {
  return STATIC_REQUEST_HEADERS.has(name) || name.startsWith("mcp-param-");
}

function collectRelayHeaders(request: Request, hints: JsonRpcHints): Record<string, string> | Response {
  const headers: Record<string, string> = {};
  let count = 0;
  for (const [rawName, value] of request.headers) {
    const name = rawName.toLowerCase();
    if (!isAllowedRequestHeader(name)) continue;

    if (name.length > MAX_HEADER_NAME_CHARS || value.length > MAX_HEADER_VALUE_CHARS) {
      return json({ error: "MCP forwarding header exceeds the configured size limit." }, 431);
    }
    if (name.startsWith("mcp-param-") && name.length === "mcp-param-".length) {
      return json({ error: "Malformed MCP parameter header." }, 400);
    }
    count += 1;
    if (count > MAX_FORWARDED_HEADERS) return json({ error: "Too many MCP forwarding headers." }, 431);
    headers[name] = value;
  }

  const suppliedMethod = headers["mcp-method"];
  if (suppliedMethod && hints.method && suppliedMethod !== hints.method) {
    return headerMismatch(hints.id, "Header mismatch: Mcp-Method does not match the JSON-RPC method.");
  }
  const suppliedName = headers["mcp-name"];
  if (suppliedName && hints.name && suppliedName !== hints.name) {
    return headerMismatch(hints.id, "Header mismatch: Mcp-Name does not match the JSON-RPC request principal.");
  }
  const suppliedVersion = headers["mcp-protocol-version"];
  if (suppliedVersion && hints.protocolVersion && suppliedVersion !== hints.protocolVersion) {
    return headerMismatch(hints.id, "Header mismatch: MCP-Protocol-Version does not match the request _meta envelope.");
  }

  if (!suppliedMethod && hints.method && isSafeAsciiHeaderValue(hints.method)) headers["mcp-method"] = hints.method;
  if (!suppliedName && hints.name && isSafeAsciiHeaderValue(hints.name)) headers["mcp-name"] = hints.name;
  if (!suppliedVersion && hints.protocolVersion && isSafeAsciiHeaderValue(hints.protocolVersion)) {
    headers["mcp-protocol-version"] = hints.protocolVersion;
  }
  headers.accept = MCP_POST_ACCEPT;
  headers["content-type"] = "application/json";
  return headers;
}

async function handleMcp(request: Request, origin: string, env: Env): Promise<Response> {
  if (request.method !== "POST" && request.method !== "DELETE") {
    return new Response("Method not allowed", { status: 405, headers: { allow: "POST, DELETE" } });
  }

  if (request.method === "POST" && mediaType(request) !== "application/json") {
    return json({ error: "MCP POST requests must use application/json." }, 415);
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

  const hints = request.method === "POST" ? parseJsonRpcHints(body) : { id: null };
  const collected = request.method === "POST" ? collectRelayHeaders(request, hints) : {};
  if (collected instanceof Response) return collected;

  const relayRequest: CloudMcpRequest = {
    type: "mcp_request",
    requestId: randomId("rpc"),
    method: request.method as "POST" | "DELETE",
    headers: collected,
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
        error: { code: -32001, message: error instanceof Error ? error.message : "VS Code bridge unavailable." },
        id: hints.id ?? null,
      },
      503,
    );
  }
}

function withIssuer(response: Response, origin: string): Response {
  if (response.status < 300 || response.status >= 400) return response;
  const location = response.headers.get("location");
  if (!location) return response;
  try {
    const redirect = new URL(location);
    redirect.searchParams.set("iss", origin);
    const headers = new Headers(response.headers);
    headers.set("location", redirect.toString());
    return new Response(response.body, { status: response.status, headers });
  } catch {
    return response;
  }
}

async function rewriteAuthorizeHtml(response: Response): Promise<Response> {
  if (!(response.headers.get("content-type") ?? "").toLowerCase().includes("text/html")) return response;
  const body = (await response.text())
    .replaceAll("<strong>ChatGPTBridge.exe</strong>", "<strong>ChatGPT Bridge VS Code extension</strong>")
    .replaceAll("paired Windows bridge", "paired VS Code workspace")
    .replaceAll("Authorize this PC", "Authorize this VS Code");
  return new Response(body, { status: response.status, headers: response.headers });
}

async function preflightBaseRoute(request: Request, pathname: string): Promise<Response | null> {
  const method = request.method.toUpperCase();
  let maxBytes: number | null = null;
  let expectedType: string | null = null;
  let requireEmpty = false;

  if (pathname === "/register" && method === "POST") {
    maxBytes = MAX_OAUTH_BODY_BYTES;
    expectedType = "application/json";
  } else if ((pathname === "/token" || pathname === "/authorize") && method === "POST") {
    maxBytes = MAX_OAUTH_BODY_BYTES;
    expectedType = "application/x-www-form-urlencoded";
  } else if ((pathname === "/device/register" || pathname === "/device/pairing") && method === "POST") {
    maxBytes = MAX_DEVICE_CONTROL_BODY_BYTES;
    requireEmpty = true;
  }

  if (expectedType && mediaType(request) !== expectedType) {
    return json({ error: `Expected Content-Type ${expectedType}.` }, 415);
  }
  if (maxBytes === null) return null;

  let body: string;
  try {
    body = await readBoundedText(request.clone(), maxBytes);
  } catch {
    return json({ error: "Request body is too large." }, 413);
  }
  if (requireEmpty && body.trim().length > 0) return json({ error: "This endpoint does not accept a request body." }, 400);
  return null;
}

const baseFetch = baseHandler.fetch as (request: Request, env: Env) => Promise<Response>;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/mcp") return handleMcp(request, url.origin, env);

    const preflight = await preflightBaseRoute(request, url.pathname);
    if (preflight) return preflight;

    const response = await baseFetch(request, env);
    if (url.pathname === "/authorize") return rewriteAuthorizeHtml(withIssuer(response, url.origin));
    return response;
  },
} satisfies ExportedHandler<Env>;
