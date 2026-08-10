import WebSocket from "ws";
import { cloudConfig, websocketUrl } from "./cloudConfig.js";
import {
  loadCloudCredentials,
  saveCloudCredentials,
  type CloudDeviceCredentials,
} from "./cloudCredentials.js";

const MAX_RELAY_BODY_BYTES = 6 * 1024 * 1024;
const RESPONSE_HEADERS = ["content-type", "mcp-session-id", "cache-control"];

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
    (item.method === "POST" || item.method === "DELETE") &&
    typeof item.body === "string" &&
    item.headers !== null &&
    typeof item.headers === "object"
  );
}

async function jsonRequest<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, init);
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

  if (!status.paired && (!status.pairingCode || !status.pairingExpiresAt || status.pairingExpiresAt <= Date.now() + 30_000)) {
    status = await deviceRequest<DeviceStatusResponse>(baseUrl, credentials, "/device/pairing", "POST");
  }

  if (!status.paired) {
    credentials = {
      ...credentials,
      ...(status.pairingCode ? { pairingCode: status.pairingCode } : {}),
      ...(status.pairingExpiresAt ? { pairingExpiresAt: status.pairingExpiresAt } : {}),
    };
    await saveCloudCredentials(credentials);
  } else if (credentials.pairingCode || credentials.pairingExpiresAt) {
    const { pairingCode: _pairingCode, pairingExpiresAt: _pairingExpiresAt, ...pairedCredentials } = credentials;
    credentials = pairedCredentials;
    await saveCloudCredentials(credentials);
  }

  return { credentials, status };
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

  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === "string" && value.length <= 4096) headers.set(name, value);
  }
  if (request.method === "POST" && !headers.has("content-type")) headers.set("content-type", "application/json");

  try {
    const response = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, {
      method: request.method,
      headers,
      ...(request.method === "POST" ? { body: request.body } : {}),
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
        const { credentials, status } = await ensureDevice(config.baseUrl);
        if (!status.paired && credentials.pairingCode) {
          console.log(`Cloud pairing:    ${credentials.pairingCode}`);
          console.log(`Pairing page:     ${config.baseUrl}/pair/${encodeURIComponent(credentials.pairingCode)}`);
          console.log("                   Connect the ChatGPT app, then enter this code on the authorization page.");
        } else if (status.paired) {
          console.log(`Cloud device:     paired (${credentials.deviceId})`);
        }

        const socket = new WebSocket(websocketUrl(config.baseUrl, credentials.deviceId), {
          headers: { authorization: `Bearer ${credentials.deviceSecret}` },
          maxPayload: MAX_RELAY_BODY_BYTES + 64 * 1024,
        });
        activeSocket = socket;

        await new Promise<void>((resolve, reject) => {
          let opened = false;
          socket.once("open", () => {
            opened = true;
            reconnectDelayMs = 1_000;
            console.log(`Cloud relay:      connected to ${config.baseUrl}`);
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
          socket.once("close", () => resolve());
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
