import { DurableObject } from "cloudflare:workers";
import { randomId } from "./crypto.js";
import { MAX_MCP_BODY_BYTES, RELAY_TIMEOUT_MS, type CloudMcpRequest, type CloudMcpResponse } from "./protocol.js";

interface Env {}

interface SocketAttachment {
  deviceId: string;
  connectionId: string;
  connectedAt: number;
  focusedAt: number;
  windowId?: string;
}

interface PendingRequest {
  socket: WebSocket;
  resolve: (response: CloudMcpResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface AgentFocusMessage {
  type: "agent_focus";
  windowId: string;
  focusedAt: number;
}

const MAX_RESPONSE_HEADERS = 32;
const MAX_HEADER_CHARS = 4096;
const MAX_DEVICE_SOCKETS = 16;

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
      typeof value.connectedAt !== "number" ||
      typeof value.focusedAt !== "number"
    ) {
      return null;
    }
    return value as SocketAttachment;
  } catch {
    return null;
  }
}

function parseFocusMessage(message: string): AgentFocusMessage | null {
  try {
    const value = JSON.parse(message) as Partial<AgentFocusMessage>;
    if (
      value.type !== "agent_focus" ||
      typeof value.windowId !== "string" ||
      value.windowId.length === 0 ||
      value.windowId.length > 200 ||
      typeof value.focusedAt !== "number" ||
      !Number.isFinite(value.focusedAt)
    ) {
      return null;
    }
    return value as AgentFocusMessage;
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

    const openSockets = this.ctx.getWebSockets()
      .filter((socket) => socket.readyState === WebSocket.OPEN)
      .map((socket) => ({ socket, attachment: socketAttachment(socket) }))
      .sort((a, b) => (a.attachment?.connectedAt ?? 0) - (b.attachment?.connectedAt ?? 0));
    while (openSockets.length >= MAX_DEVICE_SOCKETS) {
      const oldest = openSockets.shift();
      if (!oldest) break;
      this.rejectPendingForSocket(oldest.socket, "VS Code window connection was evicted while an MCP call was in flight.");
      try {
        oldest.socket.close(4002, "Too many VS Code windows connected for this device");
      } catch {
        // Already closing.
      }
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    const now = Date.now();
    const attachment: SocketAttachment = {
      deviceId,
      connectionId: randomId("conn"),
      connectedAt: now,
      focusedAt: now,
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
    if (!socket) throw new Error("The paired VS Code extension is offline.");
    if (this.pending.has(request.requestId)) throw new Error("Duplicate relay request ID.");

    return new Promise<CloudMcpResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.requestId);
        reject(new Error("Timed out waiting for the VS Code extension."));
      }, RELAY_TIMEOUT_MS);
      this.pending.set(request.requestId, { socket, resolve, reject, timer });
      try {
        socket.send(JSON.stringify(request));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(request.requestId);
        reject(error instanceof Error ? error : new Error("Unable to send request to the VS Code extension."));
      }
    });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;

    const focus = parseFocusMessage(message);
    if (focus) {
      const attachment = socketAttachment(socket);
      if (!attachment) return;
      socket.serializeAttachment({
        ...attachment,
        windowId: focus.windowId,
        focusedAt: Date.now(),
      } satisfies SocketAttachment);
      return;
    }

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
    this.rejectPendingForSocket(socket, "VS Code disconnected while an MCP call was in flight.");
  }

  async webSocketError(socket: WebSocket, error: unknown): Promise<void> {
    console.error("Device WebSocket error", error);
    this.rejectPendingForSocket(socket, "VS Code WebSocket failed while an MCP call was in flight.");
  }

  private activeSocket(): WebSocket | undefined {
    let selected: { socket: WebSocket; rank: number; connectedAt: number } | undefined;
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      const attachment = socketAttachment(socket);
      const rank = attachment?.focusedAt ?? 0;
      const connectedAt = attachment?.connectedAt ?? 0;
      if (!selected || rank > selected.rank || (rank === selected.rank && connectedAt >= selected.connectedAt)) {
        selected = { socket, rank, connectedAt };
      }
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
