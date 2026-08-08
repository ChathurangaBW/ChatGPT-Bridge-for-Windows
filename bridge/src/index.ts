import { once } from "node:events";
import { bridgePorts } from "./config.js";
import { bridgeSecretPath, ensureBridgeSecret } from "./secret.js";
import { EditorStateStore } from "./stateStore.js";
import { startEditorSocketServer } from "./editorSocketServer.js";
import { startMcpHttpServer } from "./mcpServer.js";

const { wsPort, mcpPort } = bridgePorts();
const token = await ensureBridgeSecret();
const store = new EditorStateStore();
const websocket = startEditorSocketServer({ port: wsPort, token, store });
const { server: httpServer, closeMcp } = startMcpHttpServer({ port: mcpPort, store });

function closeWebSocketServer(): Promise<void> {
  for (const client of websocket.clients) client.terminate();
  if (websocket.address() === null) return Promise.resolve();
  return new Promise((resolve) => websocket.close(() => resolve()));
}

function closeHttpServer(): Promise<void> {
  if (!httpServer.listening) return Promise.resolve();
  return new Promise((resolve) => httpServer.close(() => resolve()));
}

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await Promise.allSettled([closeWebSocketServer(), closeHttpServer(), closeMcp()]);
}

const startupResults = await Promise.allSettled([once(websocket, "listening"), once(httpServer, "listening")]);
const startupFailure = startupResults.find((item): item is PromiseRejectedResult => item.status === "rejected");
if (startupFailure) {
  await shutdown();
  throw startupFailure.reason;
}

function handleFatalServerError(label: string, error: Error): void {
  console.error(`${label} server error`, error);
  process.exitCode = 1;
  void shutdown();
}

websocket.on("error", (error) => handleFatalServerError("VS Code WebSocket", error));
httpServer.on("error", (error) => handleFatalServerError("MCP HTTP", error));

console.log("ChatGPT Bridge for Windows v0.1.0");
console.log(`VS Code socket: ws://127.0.0.1:${wsPort}`);
console.log(`MCP endpoint:    http://127.0.0.1:${mcpPort}/mcp`);
console.log(`Pairing secret:  ${bridgeSecretPath()}`);

function handleSignal(): void {
  void shutdown().finally(() => process.exit(0));
}

process.on("SIGINT", handleSignal);
process.on("SIGTERM", handleSignal);
