import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import WebSocket from "ws";
import { handleMcpRequest, type CloudMcpRequest } from "./mcp.js";

const CLOUD_URL = "https://lucky-heart-f5b9.chatgpt-bridge.workers.dev";
const DEVICE_ID_KEY = "chatgptBridge.cloud.deviceId";
const DEVICE_SECRET_KEY = "chatgptBridge.cloud.deviceSecret";
const PAIRING_CODE_KEY = "chatgptBridge.cloud.pairingCode";
const PAIRING_EXPIRES_KEY = "chatgptBridge.cloud.pairingExpiresAt";
const MAX_MESSAGE_BYTES = 6 * 1024 * 1024 + 64 * 1024;
const HTTP_TIMEOUT_MS = 15_000;
const PAIR_REFRESH_MS = 15_000;

export type CloudStatus = "connecting" | "connected" | "disconnected";

export interface CloudStatusDetails {
  status: CloudStatus;
  detail: string;
  deviceId?: string;
  paired?: boolean;
  pairingCode?: string;
  pairingExpiresAt?: number;
}

interface DeviceCredentials {
  deviceId: string;
  deviceSecret: string;
  pairingCode?: string;
  pairingExpiresAt?: number;
}

interface RegistrationResponse {
  deviceId: string;
  deviceSecret: string;
  pairingCode: string;
  pairingExpiresAt: number;
}

interface DeviceStatusResponse {
  deviceId: string;
  connected: boolean;
  paired: boolean;
  pairingCode?: string;
  pairingExpiresAt?: number;
}

interface LegacyCredentialFile {
  baseUrl?: unknown;
  deviceId?: unknown;
  deviceSecret?: unknown;
  pairingCode?: unknown;
  pairingExpiresAt?: unknown;
}

function websocketUrl(deviceId: string): string {
  const url = new URL(CLOUD_URL);
  url.protocol = "wss:";
  url.pathname = "/device/connect";
  url.searchParams.set("device_id", deviceId);
  return url.toString();
}

function legacyCredentialPath(): string {
  const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  return path.join(localAppData, "ChatGPTBridge", "cloud-device.json");
}

function isCloudMcpRequest(value: unknown): value is CloudMcpRequest {
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

async function jsonRequest<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body && typeof (body as { error?: unknown }).error === "string"
      ? (body as { error: string }).error
      : text || `HTTP ${response.status}`;
    throw new Error(message);
  }
  return body as T;
}

export class CloudExtensionClient implements vscode.Disposable {
  private socket: WebSocket | null = null;
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pairingTimer: NodeJS.Timeout | null = null;
  private reconnectDelayMs = 1_000;
  private credentials: DeviceCredentials | null = null;
  private currentStatus: CloudStatusDetails = { status: "disconnected", detail: "Not connected yet." };

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly onStatus: (details: CloudStatusDetails) => void,
  ) {}

  get status(): CloudStatusDetails {
    return this.currentStatus;
  }

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  dispose(): void {
    this.stop();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pairingTimer) clearInterval(this.pairingTimer);
    this.reconnectTimer = null;
    this.pairingTimer = null;
    this.socket?.close(1000, "VS Code extension deactivated");
    this.socket = null;
  }

  announceFocus(): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || !vscode.window.state.focused) return;
    socket.send(JSON.stringify({
      type: "agent_focus",
      windowId: vscode.env.sessionId,
      focusedAt: Date.now(),
    }));
  }

  async openPairingPage(): Promise<void> {
    const code = this.currentStatus.pairingCode;
    if (!code) {
      void vscode.window.showInformationMessage("ChatGPT Bridge does not currently have an active pairing code.");
      return;
    }
    await vscode.env.openExternal(vscode.Uri.parse(`${CLOUD_URL}/pair/${encodeURIComponent(code)}`));
  }

  async copyPairingCode(): Promise<void> {
    const code = this.currentStatus.pairingCode;
    if (!code) return;
    await vscode.env.clipboard.writeText(code);
    void vscode.window.showInformationMessage("ChatGPT Bridge pairing code copied.");
  }

  private setStatus(details: CloudStatusDetails): void {
    this.currentStatus = details;
    this.onStatus(details);
  }

  private async loadCredentials(): Promise<DeviceCredentials | null> {
    const deviceId = this.context.globalState.get<string>(DEVICE_ID_KEY);
    const deviceSecret = await this.context.secrets.get(DEVICE_SECRET_KEY);
    if (deviceId && deviceSecret) {
      return {
        deviceId,
        deviceSecret,
        pairingCode: this.context.globalState.get<string>(PAIRING_CODE_KEY),
        pairingExpiresAt: this.context.globalState.get<number>(PAIRING_EXPIRES_KEY),
      };
    }
    return this.migrateLegacyCredentials();
  }

  private async migrateLegacyCredentials(): Promise<DeviceCredentials | null> {
    try {
      const parsed = JSON.parse(await readFile(legacyCredentialPath(), "utf8")) as LegacyCredentialFile;
      if (
        parsed.baseUrl !== CLOUD_URL ||
        typeof parsed.deviceId !== "string" ||
        typeof parsed.deviceSecret !== "string" ||
        parsed.deviceId.length === 0 ||
        parsed.deviceSecret.length < 32
      ) {
        return null;
      }
      const credentials: DeviceCredentials = {
        deviceId: parsed.deviceId,
        deviceSecret: parsed.deviceSecret,
        ...(typeof parsed.pairingCode === "string" ? { pairingCode: parsed.pairingCode } : {}),
        ...(typeof parsed.pairingExpiresAt === "number" ? { pairingExpiresAt: parsed.pairingExpiresAt } : {}),
      };
      await this.saveCredentials(credentials);
      return credentials;
    } catch {
      return null;
    }
  }

  private async saveCredentials(credentials: DeviceCredentials): Promise<void> {
    await this.context.secrets.store(DEVICE_SECRET_KEY, credentials.deviceSecret);
    await this.context.globalState.update(DEVICE_ID_KEY, credentials.deviceId);
    await this.context.globalState.update(PAIRING_CODE_KEY, credentials.pairingCode);
    await this.context.globalState.update(PAIRING_EXPIRES_KEY, credentials.pairingExpiresAt);
  }

  private async registerDevice(): Promise<DeviceCredentials> {
    const registered = await jsonRequest<RegistrationResponse>(`${CLOUD_URL}/device/register`, { method: "POST" });
    const credentials: DeviceCredentials = {
      deviceId: registered.deviceId,
      deviceSecret: registered.deviceSecret,
      pairingCode: registered.pairingCode,
      pairingExpiresAt: registered.pairingExpiresAt,
    };
    await this.saveCredentials(credentials);
    return credentials;
  }

  private async deviceRequest<T>(credentials: DeviceCredentials, endpoint: string, method: "GET" | "POST"): Promise<T> {
    const url = new URL(endpoint, CLOUD_URL);
    url.searchParams.set("device_id", credentials.deviceId);
    return jsonRequest<T>(url.toString(), {
      method,
      headers: { authorization: `Bearer ${credentials.deviceSecret}` },
    });
  }

  private async ensureDevice(): Promise<{ credentials: DeviceCredentials; status: DeviceStatusResponse }> {
    let credentials = await this.loadCredentials();
    if (!credentials) credentials = await this.registerDevice();

    let status: DeviceStatusResponse;
    try {
      status = await this.deviceRequest<DeviceStatusResponse>(credentials, "/device/status", "GET");
    } catch (error) {
      if (!/invalid_device_credential|unknown device/i.test(error instanceof Error ? error.message : "")) throw error;
      credentials = await this.registerDevice();
      status = await this.deviceRequest<DeviceStatusResponse>(credentials, "/device/status", "GET");
    }

    if (!status.pairingCode || !status.pairingExpiresAt || status.pairingExpiresAt <= Date.now()) {
      status = await this.deviceRequest<DeviceStatusResponse>(credentials, "/device/pairing", "POST");
    }
    const updated: DeviceCredentials = {
      ...credentials,
      ...(status.pairingCode ? { pairingCode: status.pairingCode } : {}),
      ...(status.pairingExpiresAt ? { pairingExpiresAt: status.pairingExpiresAt } : {}),
    };
    await this.saveCredentials(updated);
    return { credentials: updated, status };
  }

  private beginPairingRefresh(): void {
    if (this.pairingTimer) clearInterval(this.pairingTimer);
    this.pairingTimer = setInterval(() => {
      const credentials = this.credentials;
      if (!credentials) return;
      void this.deviceRequest<DeviceStatusResponse>(credentials, "/device/status", "GET")
        .then(async (status) => {
          let next = status;
          if (!status.pairingCode || !status.pairingExpiresAt || status.pairingExpiresAt <= Date.now()) {
            next = await this.deviceRequest<DeviceStatusResponse>(credentials, "/device/pairing", "POST");
          }
          const updated: DeviceCredentials = {
            ...credentials,
            ...(next.pairingCode ? { pairingCode: next.pairingCode } : {}),
            ...(next.pairingExpiresAt ? { pairingExpiresAt: next.pairingExpiresAt } : {}),
          };
          this.credentials = updated;
          await this.saveCredentials(updated);
          this.setStatus({
            status: this.socket?.readyState === WebSocket.OPEN ? "connected" : "connecting",
            detail: next.paired ? "Connected and authorized." : "Connected. Pair ChatGPT using the code shown here.",
            deviceId: updated.deviceId,
            paired: next.paired,
            pairingCode: updated.pairingCode,
            pairingExpiresAt: updated.pairingExpiresAt,
          });
        })
        .catch(() => undefined);
    }, PAIR_REFRESH_MS);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.setStatus({ status: "connecting", detail: "Connecting directly to ChatGPT Bridge cloud relay…" });
    try {
      const { credentials, status } = await this.ensureDevice();
      this.credentials = credentials;
      this.setStatus({
        status: "connecting",
        detail: status.paired ? "Authorized. Opening secure relay…" : "Pair ChatGPT using the displayed code.",
        deviceId: credentials.deviceId,
        paired: status.paired,
        pairingCode: credentials.pairingCode,
        pairingExpiresAt: credentials.pairingExpiresAt,
      });

      const socket = new WebSocket(websocketUrl(credentials.deviceId), {
        headers: { authorization: `Bearer ${credentials.deviceSecret}` },
        maxPayload: MAX_MESSAGE_BYTES,
      });
      this.socket = socket;

      socket.once("open", () => {
        this.reconnectDelayMs = 1_000;
      });

      socket.on("message", (raw) => {
        if (Buffer.byteLength(raw.toString(), "utf8") > MAX_MESSAGE_BYTES) return;
        let message: unknown;
        try {
          message = JSON.parse(raw.toString("utf8"));
        } catch {
          return;
        }
        if (message && typeof message === "object" && (message as { type?: unknown }).type === "agent_ready") {
          this.setStatus({
            status: "connected",
            detail: status.paired ? "Connected and authorized." : "Connected. Pair ChatGPT using the displayed code.",
            deviceId: credentials.deviceId,
            paired: status.paired,
            pairingCode: credentials.pairingCode,
            pairingExpiresAt: credentials.pairingExpiresAt,
          });
          this.announceFocus();
          this.beginPairingRefresh();
          return;
        }
        if (!isCloudMcpRequest(message)) return;
        void handleMcpRequest(message).then((response) => {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(response));
        });
      });

      socket.once("close", () => {
        if (this.socket === socket) this.socket = null;
        if (this.pairingTimer) clearInterval(this.pairingTimer);
        this.pairingTimer = null;
        if (!this.stopped) this.scheduleReconnect("Cloud relay disconnected.");
      });
      socket.once("error", (error) => {
        if (!this.stopped) this.setStatus({ status: "disconnected", detail: error.message, deviceId: credentials.deviceId });
      });
    } catch (error) {
      this.scheduleReconnect(error instanceof Error ? error.message : "Cloud relay connection failed.");
    }
  }

  private scheduleReconnect(detail: string): void {
    if (this.stopped) return;
    this.setStatus({ status: "disconnected", detail, deviceId: this.credentials?.deviceId });
    if (this.reconnectTimer) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }
}
