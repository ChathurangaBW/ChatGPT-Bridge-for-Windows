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
const token = await ensureBridgeSecret();
const store = new EditorStateStore();
const websocket = startEditorSocketServer({ port: wsPort, token, store });
const { server: httpServer, closeMcp } = startMcpHttpServer({ port: mcpPort, store });

console.log(`ChatGPT Bridge for Windows v0.1.0`);
console.log(`VS Code socket: ws://127.0.0.1:${wsPort}`);
console.log(`MCP endpoint:    http://127.0.0.1:${mcpPort}/mcp`);
console.log(`Pairing secret:  ${bridgeSecretPath()}`);

async function shutdown(): Promise<void> {
  websocket.close();
  httpServer.close();
  await closeMcp();
}

process.on("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.on("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
