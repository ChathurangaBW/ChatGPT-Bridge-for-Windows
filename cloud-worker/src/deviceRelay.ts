import { DurableObject } from "cloudflare:workers";
import { randomId } from "./crypto.js";
import { MAX_MCP_BODY_BYTES, RELAY_TIMEOUT_MS, type CloudMcpRequest, type CloudMcpResponse } from "./protocol.js";

interface Env {}

interface SocketAttachment {
  deviceId: string;
  connectionId: string;
  connectedAt: number;
}

interface PendingRequest {
  socket: WebSocket;
  resolve: (response: CloudMcpResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const MAX_RESPONSE_HEADERS = 32;
const MAX_HEADER_CHARS = 4096;

function bodyBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function socketAttachment(socket: WebSocket): SocketAttachment | null {
  try {
    const value = socket.deserializeAttachment() as Partial<SocketAttachment> | null;
    if (
      !value ||
      typeof value.deviceId !== "string" ||
      typeof value.connectionId !== "string" ||
      typeof value.connectedAt !== "number"
    ) {
      return null;
    }
    return value as SocketAttachment;
  } catch {
    return null;
  }
}

function parseMcpResponse(message: string): CloudMcpResponse | null {
  try {
    const value = JSON.parse(message) as Partial<CloudMcpResponse>;
    if (
      value.type !== "mcp_response" ||
      typeof value.requestId !== "string" ||
      value.requestId.length === 0 ||
      value.requestId.length > 200 ||
      typeof value.status !== "number" ||
      !Number.isInteger(value.status) ||
      value.status < 100 ||
      value.status > 599 ||
      typeof value.body !== "string" ||
      bodyBytes(value.body) > MAX_MCP_BODY_BYTES ||
      !value.headers ||
      typeof value.headers !== "object"
    ) {
      return null;
    }
    const entries = Object.entries(value.headers);
    if (
      entries.length > MAX_RESPONSE_HEADERS ||
      entries.some(([name, headerValue]) =>
        name.length === 0 ||
        name.length > 128 ||
        typeof headerValue !== "string" ||
        headerValue.length > MAX_HEADER_CHARS
      )
    ) {
      return null;
    }
    return value as CloudMcpResponse;
  } catch {
    return null;
  }
}

export class DeviceRelay extends DurableObject<Env> {
  private readonly pending = new Map<string, PendingRequest>();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/connect") return new Response("Not found", { status: 404 });
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const deviceId = request.headers.get("X-Bridge-Device-Id");
    if (!deviceId || deviceId !== this.ctx.id.name) return new Response("Device identity mismatch", { status: 403 });

    for (const existing of this.ctx.getWebSockets()) {
      this.rejectPendingForSocket(existing, "Windows bridge connection was replaced while an MCP call was in flight.");
      try {
        existing.close(4001, "Replaced by a newer bridge connection");
      } catch {
        // The connection may already be closing.
      }
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    const attachment: SocketAttachment = {
      deviceId,
      connectionId: randomId("conn"),
      connectedAt: Date.now(),
    };
    server.serializeAttachment(attachment);
    server.send(JSON.stringify({ type: "agent_ready", deviceId }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async isConnected(): Promise<boolean> {
    return Boolean(this.activeSocket());
  }

  async forwardMcp(request: CloudMcpRequest): Promise<CloudMcpResponse> {
    const socket = this.activeSocket();
    if (!socket) throw new Error("The paired Windows bridge is offline.");
    if (this.pending.has(request.requestId)) throw new Error("Duplicate relay request ID.");

    return new Promise<CloudMcpResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.requestId);
        reject(new Error("Timed out waiting for the Windows bridge."));
      }, RELAY_TIMEOUT_MS);
      this.pending.set(request.requestId, { socket, resolve, reject, timer });
      try {
        socket.send(JSON.stringify(request));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(request.requestId);
        reject(error instanceof Error ? error : new Error("Unable to send request to Windows bridge."));
      }
    });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    const response = parseMcpResponse(message);
    if (!response) return;
    const pending = this.pending.get(response.requestId);
    if (!pending || pending.socket !== socket) return;
    clearTimeout(pending.timer);
    this.pending.delete(response.requestId);
    pending.resolve(response);
  }

  async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
    try {
      socket.close(code, reason);
    } catch {
      // Cloudflare may already have completed the close handshake.
    }
    this.rejectPendingForSocket(socket, "Windows bridge disconnected while an MCP call was in flight.");
  }

  async webSocketError(socket: WebSocket, error: unknown): Promise<void> {
    console.error("Device WebSocket error", error);
    this.rejectPendingForSocket(socket, "Windows bridge WebSocket failed while an MCP call was in flight.");
  }

  private activeSocket(): WebSocket | undefined {
    let selected: { socket: WebSocket; connectedAt: number } | undefined;
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      const attachment = socketAttachment(socket);
      const connectedAt = attachment?.connectedAt ?? 0;
      if (!selected || connectedAt >= selected.connectedAt) selected = { socket, connectedAt };
    }
    return selected?.socket;
  }

  private rejectPendingForSocket(socket: WebSocket, message: string): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.socket !== socket) continue;
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
      this.pending.delete(requestId);
    }
  }
}
