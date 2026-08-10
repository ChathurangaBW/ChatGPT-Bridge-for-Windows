import { DurableObject } from "cloudflare:workers";
import { RELAY_TIMEOUT_MS, type CloudMcpRequest, type CloudMcpResponse } from "./protocol.js";

interface Env {}

interface SocketAttachment {
  deviceId: string;
  connectedAt: number;
}

interface PendingRequest {
  resolve: (response: CloudMcpResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function parseMcpResponse(message: string): CloudMcpResponse | null {
  try {
    const value = JSON.parse(message) as Partial<CloudMcpResponse>;
    if (
      value.type !== "mcp_response" ||
      typeof value.requestId !== "string" ||
      typeof value.status !== "number" ||
      typeof value.body !== "string" ||
      !value.headers ||
      typeof value.headers !== "object"
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
    const attachment: SocketAttachment = { deviceId, connectedAt: Date.now() };
    server.serializeAttachment(attachment);
    server.send(JSON.stringify({ type: "agent_ready", deviceId }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async isConnected(): Promise<boolean> {
    return this.ctx.getWebSockets().some((socket) => socket.readyState === WebSocket.OPEN);
  }

  async forwardMcp(request: CloudMcpRequest): Promise<CloudMcpResponse> {
    const socket = this.ctx.getWebSockets().find((candidate) => candidate.readyState === WebSocket.OPEN);
    if (!socket) throw new Error("The paired Windows bridge is offline.");
    if (this.pending.has(request.requestId)) throw new Error("Duplicate relay request ID.");

    return new Promise<CloudMcpResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.requestId);
        reject(new Error("Timed out waiting for the Windows bridge."));
      }, RELAY_TIMEOUT_MS);
      this.pending.set(request.requestId, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify(request));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(request.requestId);
        reject(error instanceof Error ? error : new Error("Unable to send request to Windows bridge."));
      }
    });
  }

  async webSocketMessage(_socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    const response = parseMcpResponse(message);
    if (!response) return;
    const pending = this.pending.get(response.requestId);
    if (!pending) return;
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
    if (this.ctx.getWebSockets().some((candidate) => candidate.readyState === WebSocket.OPEN)) return;
    this.rejectPending("Windows bridge disconnected while an MCP call was in flight.");
  }

  async webSocketError(_socket: WebSocket, error: unknown): Promise<void> {
    console.error("Device WebSocket error", error);
    this.rejectPending("Windows bridge WebSocket failed while an MCP call was in flight.");
  }

  private rejectPending(message: string): void {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
      this.pending.delete(requestId);
    }
  }
}
