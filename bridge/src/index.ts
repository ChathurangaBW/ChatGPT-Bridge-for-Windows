import { bridgeSecretPath, ensureBridgeSecret } from "./secret.js";
import { EditorStateStore } from "./stateStore.js";
import { startEditorSocketServer } from "./editorSocketServer.js";
import { startMcpHttpServer } from "./mcpServer.js";

function envPort(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) {
    throw new Error(`${name} must be an integer between 1024 and 65535.`);
  }
  return parsed;
}

const wsPort = envPort("BRIDGE_WS_PORT", 47321);
const mcpPort = envPort("BRIDGE_MCP_PORT", 47322);
if (wsPort === mcpPort) throw new Error("BRIDGE_WS_PORT and BRIDGE_MCP_PORT must be different.");

const token = await ensureBridgeSecret();
const store = new EditorStateStore();
const websocket = startEditorSocketServer({ port: wsPort, token, store });
const { server: httpServer, closeMcp } = startMcpHttpServer({ port: mcpPort, store });

websocket.on("error", (error) => console.error("VS Code WebSocket server error", error));
httpServer.on("error", (error) => console.error("MCP HTTP server error", error));

console.log("ChatGPT Bridge for Windows v0.1.0");
console.log(`VS Code socket: ws://127.0.0.1:${wsPort}`);
console.log(`MCP endpoint:    http://127.0.0.1:${mcpPort}/mcp`);
console.log(`Pairing secret:  ${bridgeSecretPath()}`);

function closeWebSocketServer(): Promise<void> {
  for (const client of websocket.clients) client.terminate();
  return new Promise((resolve) => websocket.close(() => resolve()));
}

function closeHttpServer(): Promise<void> {
  return new Promise((resolve) => httpServer.close(() => resolve()));
}

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await Promise.allSettled([closeWebSocketServer(), closeHttpServer(), closeMcp()]);
}

function handleSignal(): void {
  void shutdown().finally(() => process.exit(0));
}

process.on("SIGINT", handleSignal);
process.on("SIGTERM", handleSignal);
