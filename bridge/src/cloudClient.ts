import WebSocket from "ws";
import { cloudConfig, websocketUrl } from "./cloudConfig.js";
import {
  loadCloudCredentials,
  saveCloudCredentials,
  type CloudDeviceCredentials,
} from "./cloudCredentials.js";

const MAX_RELAY_BODY_BYTES = 6 * 1024 * 1024;
const MCP_POST_ACCEPT = "application/json, text/event-stream";
const STATIC_REQUEST_HEADERS = new Set([
  "content-type",
  "accept",
  "mcp-protocol-version",
  "mcp-session-id",
  "last-event-id",
  "mcp-method",
  "mcp-name",
]);
const RESPONSE_HEADERS = ["content-type", "mcp-session-id", "cache-control"];
const MAX_RELAY_HEADERS = 48;
const MAX_HEADER_NAME_CHARS = 128;
const MAX_HEADER_VALUE_CHARS = 4096;
const PAIRING_REFRESH_INTERVAL_MS = 15_000;
const PAIRING_REFRESH_EARLY_MS = 0;
const CLOUD_HTTP_TIMEOUT_MS = 15_000;
const LOCAL_MCP_TIMEOUT_MS = 25_000;

interface RegistrationResponse {
  deviceId: string;
  deviceSecret: string;
  pairingCode: string;
  pairingExpiresAt: number;
  pairingUrl: string;
  websocketUrl: string;
}

interface DeviceStatusResponse {
  deviceId: string;
  connected: boolean;
  paired: boolean;
  pairingCode?: string;
  pairingExpiresAt?: number;
}

interface CloudMcpRequest {
  type: "mcp_request";
  requestId: string;
  method: "POST" | "DELETE";
  headers: Record<string, string>;
  body: string;
}

interface CloudMcpResponse {
  type: "mcp_response";
  requestId: string;
  status: number;
  headers: Record<string, string>;
  body: string;
}

interface JsonRpcHints {
  method?: string;
  name?: string;
  protocolVersion?: string;
}

function bodyBytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function isMcpRequest(value: unknown): value is CloudMcpRequest {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<CloudMcpRequest>;
  return (
    item.type === "mcp_request" &&
    typeof item.requestId === "string" &&
    item.requestId.length > 0 &&
    item.requestId.length <= 200 &&
    (item.method === "POST" || item.method === "DELETE") &&
    typeof item.body === "string" &&
    item.headers !== null &&
    typeof item.headers === "object"
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

function parseJsonRpcHints(body: string): JsonRpcHints {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const value = parsed as { method?: unknown; params?: unknown };
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
      ...(typeof value.method === "string" ? { method: value.method } : {}),
      ...(principal ? { name: principal } : {}),
      ...(protocolVersion ? { protocolVersion } : {}),
    };
  } catch {
    return {};
  }
}

function localMcpHeaders(request: CloudMcpRequest): Headers {
  const headers = new Headers();
  let count = 0;
  for (const [name, value] of Object.entries(request.headers)) {
    const normalized = name.toLowerCase();
    if (!isAllowedRequestHeader(normalized)) continue;
    if (normalized.length > MAX_HEADER_NAME_CHARS || typeof value !== "string" || value.length > MAX_HEADER_VALUE_CHARS) continue;
    count += 1;
    if (count > MAX_RELAY_HEADERS) break;
    headers.set(normalized, value);
  }

  if (request.method === "POST") {
    const hints = parseJsonRpcHints(request.body);
    if (!headers.has("mcp-method") && hints.method && isSafeAsciiHeaderValue(hints.method)) {
      headers.set("mcp-method", hints.method);
    }
    if (!headers.has("mcp-name") && hints.name && isSafeAsciiHeaderValue(hints.name)) {
      headers.set("mcp-name", hints.name);
    }
    if (!headers.has("mcp-protocol-version") && hints.protocolVersion && isSafeAsciiHeaderValue(hints.protocolVersion)) {
      headers.set("mcp-protocol-version", hints.protocolVersion);
    }
    headers.set("accept", MCP_POST_ACCEPT);
    headers.set("content-type", "application/json");
  }
  return headers;
}

async function jsonRequest<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(CLOUD_HTTP_TIMEOUT_MS),
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Keep the raw text for the error below.
  }
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "error" in body && typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error
        : text || `HTTP ${response.status}`;
    throw new Error(message);
  }
  return body as T;
}

async function registerDevice(baseUrl: string): Promise<CloudDeviceCredentials> {
  const registered = await jsonRequest<RegistrationResponse>(`${baseUrl}/device/register`, { method: "POST" });
  const credentials: CloudDeviceCredentials = {
    version: 1,
    baseUrl,
    deviceId: registered.deviceId,
    deviceSecret: registered.deviceSecret,
    pairingCode: registered.pairingCode,
    pairingExpiresAt: registered.pairingExpiresAt,
  };
  await saveCloudCredentials(credentials);
  return credentials;
}

async function deviceRequest<T>(
  baseUrl: string,
  credentials: CloudDeviceCredentials,
  path: string,
  method: "GET" | "POST",
): Promise<T> {
  const url = new URL(path, baseUrl);
  url.searchParams.set("device_id", credentials.deviceId);
  return jsonRequest<T>(url.toString(), {
    method,
    headers: { authorization: `Bearer ${credentials.deviceSecret}` },
  });
}

async function ensurePairing(
  baseUrl: string,
  credentials: CloudDeviceCredentials,
  existingStatus?: DeviceStatusResponse,
): Promise<{ credentials: CloudDeviceCredentials; status: DeviceStatusResponse; changed: boolean }> {
  let status = existingStatus ?? (await deviceRequest<DeviceStatusResponse>(baseUrl, credentials, "/device/status", "GET"));
  const currentCode = status.pairingCode;
  const currentExpiry = status.pairingExpiresAt;
  if (!currentCode || !currentExpiry || currentExpiry <= Date.now() + PAIRING_REFRESH_EARLY_MS) {
    status = await deviceRequest<DeviceStatusResponse>(baseUrl, credentials, "/device/pairing", "POST");
  }

  const changed = status.pairingCode !== credentials.pairingCode || status.pairingExpiresAt !== credentials.pairingExpiresAt;
  const updated: CloudDeviceCredentials = {
    ...credentials,
    ...(status.pairingCode ? { pairingCode: status.pairingCode } : {}),
    ...(status.pairingExpiresAt ? { pairingExpiresAt: status.pairingExpiresAt } : {}),
  };
  if (changed) await saveCloudCredentials(updated);
  return { credentials: updated, status, changed };
}

async function ensureDevice(baseUrl: string): Promise<{ credentials: CloudDeviceCredentials; status: DeviceStatusResponse }> {
  let credentials = await loadCloudCredentials(baseUrl);
  if (!credentials) credentials = await registerDevice(baseUrl);

  let status: DeviceStatusResponse;
  try {
    status = await deviceRequest<DeviceStatusResponse>(baseUrl, credentials, "/device/status", "GET");
  } catch (error) {
    if (!/invalid_device_credential|unknown device/i.test(error instanceof Error ? error.message : "")) throw error;
    credentials = await registerDevice(baseUrl);
    status = await deviceRequest<DeviceStatusResponse>(baseUrl, credentials, "/device/status", "GET");
  }

  const pairing = await ensurePairing(baseUrl, credentials, status);
  return { credentials: pairing.credentials, status: pairing.status };
}

function printPairing(baseUrl: string, credentials: CloudDeviceCredentials, paired: boolean): void {
  if (paired) console.log(`Cloud device:     authorized before (${credentials.deviceId})`);
  if (!credentials.pairingCode) return;
  console.log(`Cloud pairing:    ${credentials.pairingCode}`);
  console.log(`Pairing page:     ${baseUrl}/pair/${encodeURIComponent(credentials.pairingCode)}`);
  console.log("                   In ChatGPT, connect the app and enter this code when authorization opens.");
}

async function relayToLocalMcp(request: CloudMcpRequest, mcpPort: number): Promise<CloudMcpResponse> {
  if (bodyBytes(request.body) > MAX_RELAY_BODY_BYTES) {
    return {
      type: "mcp_response",
      requestId: request.requestId,
      status: 413,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ error: "Cloud MCP request exceeded the local relay size limit." }),
    };
  }

  const headers = localMcpHeaders(request);

  try {
    const response = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, {
      method: request.method,
      headers,
      ...(request.method === "POST" ? { body: request.body } : {}),
      signal: AbortSignal.timeout(LOCAL_MCP_TIMEOUT_MS),
    });
    const body = await response.text();
    if (bodyBytes(body) > MAX_RELAY_BODY_BYTES) {
      return {
        type: "mcp_response",
        requestId: request.requestId,
        status: 502,
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ error: "Local MCP response exceeded the cloud relay size limit." }),
      };
    }
    const responseHeaders: Record<string, string> = {};
    for (const name of RESPONSE_HEADERS) {
      const value = response.headers.get(name);
      if (value) responseHeaders[name] = value;
    }
    return {
      type: "mcp_response",
      requestId: request.requestId,
      status: response.status,
      headers: responseHeaders,
      body,
    };
  } catch (error) {
    return {
      type: "mcp_response",
      requestId: request.requestId,
      status: 502,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ error: error instanceof Error ? error.message : "Local MCP relay failed." }),
    };
  }
}

export interface CloudRelayClient {
  stop(): void;
}

export async function startCloudRelayClient(mcpPort: number): Promise<CloudRelayClient | null> {
  const config = cloudConfig();
  if (!config.enabled) {
    console.log("Cloud relay:      disabled by BRIDGE_CLOUD_DISABLED");
    return null;
  }

  let stopped = false;
  let activeSocket: WebSocket | null = null;
  let reconnectDelayMs = 1_000;

  const run = async (): Promise<void> => {
    while (!stopped) {
      try {
        let { credentials, status } = await ensureDevice(config.baseUrl);
        printPairing(config.baseUrl, credentials, status.paired);

        const socket = new WebSocket(websocketUrl(config.baseUrl, credentials.deviceId), {
          headers: { authorization: `Bearer ${credentials.deviceSecret}` },
          maxPayload: MAX_RELAY_BODY_BYTES + 64 * 1024,
        });
        activeSocket = socket;

        await new Promise<void>((resolve, reject) => {
          let opened = false;
          let pairingTimer: ReturnType<typeof setInterval> | null = null;
          socket.once("open", () => {
            opened = true;
            reconnectDelayMs = 1_000;
            console.log(`Cloud relay:      connected to ${config.baseUrl}`);
            pairingTimer = setInterval(() => {
              void ensurePairing(config.baseUrl, credentials)
                .then((pairing) => {
                  if (pairing.changed) printPairing(config.baseUrl, pairing.credentials, pairing.status.paired);
                  credentials = pairing.credentials;
                  status = pairing.status;
                })
                .catch((error) => console.error("Cloud pairing refresh failed:", error instanceof Error ? error.message : error));
            }, PAIRING_REFRESH_INTERVAL_MS);
          });
          socket.on("message", (raw) => {
            let message: unknown;
            try {
              message = JSON.parse(raw.toString("utf8"));
            } catch {
              return;
            }
            if (!isMcpRequest(message)) return;
            void relayToLocalMcp(message, mcpPort).then((response) => {
              if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(response));
            });
          });
          socket.once("close", () => {
            if (pairingTimer) clearInterval(pairingTimer);
            resolve();
          });
          socket.once("error", (error) => {
            if (!opened) reject(error);
          });
        });
      } catch (error) {
        if (!stopped) console.error("Cloud relay connection failed:", error instanceof Error ? error.message : error);
      } finally {
        activeSocket = null;
      }

      if (stopped) break;
      await new Promise((resolve) => setTimeout(resolve, reconnectDelayMs));
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30_000);
    }
  };

  void run();
  return {
    stop(): void {
      stopped = true;
      if (activeSocket && activeSocket.readyState < WebSocket.CLOSING) activeSocket.close(1000, "Bridge shutting down");
    },
  };
}
