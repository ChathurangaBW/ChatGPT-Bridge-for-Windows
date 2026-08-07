import { timingSafeEqual } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import type { EditorStateStore } from "./stateStore.js";
import type { BridgeHello, EditorSnapshot } from "./types.js";

const MAX_PAYLOAD_BYTES = 3 * 1024 * 1024;

function tokensEqual(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isHello(value: unknown): value is BridgeHello {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<BridgeHello>;
  return item.type === "hello" && item.client === "vscode" && typeof item.token === "string";
}

function isEditorSnapshot(value: unknown): value is EditorSnapshot {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<EditorSnapshot>;
  return (
    item.type === "editor_snapshot" &&
    Array.isArray(item.workspaceFolders) &&
    item.workspaceFolders.every((folder) => typeof folder === "string") &&
    (item.activeFile === null || typeof item.activeFile === "string") &&
    typeof item.capturedAt === "string"
  );
}

function closeUnauthorized(socket: WebSocket, reason: string): void {
  socket.close(1008, reason.slice(0, 120));
}

export function startEditorSocketServer(options: {
  port: number;
  token: string;
  store: EditorStateStore;
}): WebSocketServer {
  const server = new WebSocketServer({
    host: "127.0.0.1",
    port: options.port,
    maxPayload: MAX_PAYLOAD_BYTES,
  });

  server.on("connection", (socket) => {
    let authenticated = false;
    let counted = false;

    const authTimer = setTimeout(() => {
      if (!authenticated) closeUnauthorized(socket, "authentication timeout");
    }, 5_000);

    socket.on("message", (raw) => {
      let message: unknown;
      try {
        message = JSON.parse(raw.toString("utf8"));
      } catch {
        closeUnauthorized(socket, "invalid JSON");
        return;
      }

      if (!authenticated) {
        if (!isHello(message) || !tokensEqual(message.token, options.token)) {
          closeUnauthorized(socket, "invalid bridge token");
          return;
        }

        authenticated = true;
        counted = true;
        clearTimeout(authTimer);
        options.store.connected();
        socket.send(JSON.stringify({ type: "ready", protocol: 1 }));
        return;
      }

      if (isEditorSnapshot(message)) {
        options.store.update(message);
      }
    });

    socket.on("close", () => {
      clearTimeout(authTimer);
      if (counted) options.store.disconnected();
    });
  });

  return server;
}
