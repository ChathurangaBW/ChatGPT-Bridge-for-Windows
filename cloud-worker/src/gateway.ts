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

function unauthorized(origin: string): Response {
  return json(
    { error: "authorization_required" },
    401,
    {
      "www-authenticate": `Bearer realm="chatgpt-bridge", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="${MCP_SCOPE}"`,
    },
  );
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

function parseJsonRpcHints(body: string): JsonRpcHints {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { id: null };
    const value = parsed as {
      id?: unknown;
      method?: unknown;
      params?: unknown;
    };
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
  return json(
    {
      jsonrpc: "2.0",
      id: id ?? null,
      error: { code: -32020, message },
    },
    400,
  );
}

function isSafeAsciiHeaderValue(value: string): boolean {
  return value.length > 0 && value.length <= MAX_HEADER_VALUE_CHARS && /^[\x20-\x7e]+$/.test(value);
}

function isAllowedRequestHeader(name: string): boolean {
  if (STATIC_REQUEST_HEADERS.has(name)) return true;
  return (
    name.startsWith("mcp-param-") &&
    name.length > "mcp-param-".length &&
    name.length <= MAX_HEADER_NAME_CHARS
  );
}

function collectRelayHeaders(request: Request, hints: JsonRpcHints): Record<string, string> | Response {
  const headers: Record<string, string> = {};
  let count = 0;
  for (const [rawName, value] of request.headers) {
    const name = rawName.toLowerCase();
    if (!isAllowedRequestHeader(name)) continue;
    if (name.length > MAX_HEADER_NAME_CHARS || value.length > MAX_HEADER_VALUE_CHARS) continue;
    count += 1;
    if (count > MAX_FORWARDED_HEADERS) return json({ error: "Too many MCP forwarding headers." }, 431);
    headers[name] = value;
  }

  const suppliedMethod = headers["mcp-method"];
  if (suppliedMethod && hints.method && suppliedMethod !== hints.method) {
    return headerMismatch(hints.id, "Header mismatch: Mcp-Method does not match the JSON-RPC method.");
  }
  const suppliedVersion = headers["mcp-protocol-version"];
  if (suppliedVersion && hints.protocolVersion && suppliedVersion !== hints.protocolVersion) {
    return headerMismatch(hints.id, "Header mismatch: MCP-Protocol-Version does not match the request _meta envelope.");
  }

  if (!suppliedMethod && hints.method && isSafeAsciiHeaderValue(hints.method)) headers["mcp-method"] = hints.method;
  if (!headers["mcp-name"] && hints.name && isSafeAsciiHeaderValue(hints.name)) headers["mcp-name"] = hints.name;
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

  if (request.method === "POST") {
    const mediaType = (request.headers.get("content-type") ?? "").split(";", 1)[0]?.trim().toLowerCase();
    if (mediaType !== "application/json") return json({ error: "MCP POST requests must use application/json." }, 415);
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
        error: { code: -32001, message: error instanceof Error ? error.message : "Windows bridge unavailable." },
        id: hints.id ?? null,
      },
      503,
    );
  }
}

const baseFetch = baseHandler.fetch as (request: Request, env: Env) => Promise<Response>;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/mcp") return handleMcp(request, url.origin, env);
    return baseFetch(request, env);
  },
} satisfies ExportedHandler<Env>;
