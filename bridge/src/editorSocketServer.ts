import { randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import * as z from "zod/v4";
import type { EditorStateStore } from "./stateStore.js";
import type { BridgeHello, EditorSnapshot } from "./types.js";

const MAX_PAYLOAD_BYTES = 5 * 1024 * 1024;

const positionSchema = z.object({
  line: z.number().int().nonnegative(),
  character: z.number().int().nonnegative(),
});

const selectionSchema = z.object({
  text: z.string(),
  start: positionSchema,
  end: positionSchema,
  isEmpty: z.boolean(),
  truncated: z.boolean(),
});

const diagnosticSchema = z.object({
  file: z.string().min(1),
  message: z.string(),
  severity: z.enum(["error", "warning", "information", "hint"]),
  source: z.string().optional(),
  code: z.union([z.string(), z.number()]).optional(),
  range: z.object({ start: positionSchema, end: positionSchema }),
});

const editorSnapshotSchema = z.object({
  type: z.literal("editor_snapshot"),
  workspaceFolders: z.array(z.string().min(1)).max(100),
  activeFile: z.string().min(1).nullable(),
  languageId: z.string().max(256).nullable(),
  dirty: z.boolean(),
  content: z.string().nullable(),
  contentTruncated: z.boolean(),
  selection: selectionSchema.nullable(),
  diagnostics: z.array(diagnosticSchema).max(500),
  diagnosticsTruncated: z.boolean(),
  capturedAt: z.string().min(1).max(64),
});

function tokensEqual(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isHello(value: unknown): value is BridgeHello {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<BridgeHello>;
  return (
    item.type === "hello" &&
    item.client === "vscode" &&
    typeof item.token === "string" &&
    item.token.length <= 512 &&
    typeof item.version === "string" &&
    item.version.length <= 64
  );
}

function parseEditorSnapshot(value: unknown): EditorSnapshot | null {
  const parsed = editorSnapshotSchema.safeParse(value);
  return parsed.success ? (parsed.data as EditorSnapshot) : null;
}

function closePolicyViolation(socket: WebSocket, reason: string): void {
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
    const sessionId = randomUUID();
    let authenticated = false;
    let counted = false;
    let closing = false;

    const disconnectSession = (): void => {
      if (!counted) return;
      counted = false;
      options.store.disconnected(sessionId);
    };

    const rejectConnection = (reason: string): void => {
      if (closing) return;
      closing = true;
      disconnectSession();
      closePolicyViolation(socket, reason);
    };

    const authTimer = setTimeout(() => {
      if (!authenticated) rejectConnection("authentication timeout");
    }, 5_000);

    socket.on("message", (raw) => {
      if (closing) return;

      let message: unknown;
      try {
        message = JSON.parse(raw.toString("utf8"));
      } catch {
        rejectConnection("invalid JSON");
        return;
      }

      if (!authenticated) {
        if (!isHello(message) || !tokensEqual(message.token, options.token)) {
          rejectConnection("invalid bridge token");
          return;
        }

        authenticated = true;
        counted = true;
        clearTimeout(authTimer);
        options.store.connected(sessionId);
        socket.send(JSON.stringify({ type: "ready", protocol: 1 }));
        return;
      }

      const snapshot = parseEditorSnapshot(message);
      if (!snapshot) {
        rejectConnection("invalid editor snapshot");
        return;
      }
      options.store.update(sessionId, snapshot);
    });

    socket.on("close", () => {
      closing = true;
      clearTimeout(authTimer);
      disconnectSession();
    });
  });

  return server;
}
