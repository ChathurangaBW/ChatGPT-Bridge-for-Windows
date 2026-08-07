import WebSocket from "ws";
import { readBridgeSecret } from "./secret.js";
import type { EditorSnapshot } from "./protocol.js";

export type BridgeStatus = "connecting" | "connected" | "disconnected";

export class BridgeClient {
  private socket: WebSocket | null = null;
  private ready = false;
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private latestSnapshot: EditorSnapshot | null = null;

  constructor(
    private readonly port: number,
    private readonly onStatus: (status: BridgeStatus, detail?: string) => void,
  ) {}

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.ready = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close();
    this.socket = null;
  }

  publish(snapshot: EditorSnapshot): void {
    this.latestSnapshot = snapshot;
    if (this.ready && this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(snapshot));
    }
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.onStatus("connecting");

    let token: string;
    try {
      token = await readBridgeSecret();
    } catch (error) {
      this.scheduleReconnect(error instanceof Error ? error.message : String(error));
      return;
    }

    const socket = new WebSocket(`ws://127.0.0.1:${this.port}`);
    this.socket = socket;

    socket.once("open", () => {
      socket.send(JSON.stringify({ type: "hello", token, client: "vscode", version: "0.1.0" }));
    });

    socket.on("message", (raw) => {
      try {
        const message = JSON.parse(raw.toString("utf8")) as { type?: string };
        if (message.type === "ready") {
          this.ready = true;
          this.onStatus("connected");
          if (this.latestSnapshot) socket.send(JSON.stringify(this.latestSnapshot));
        }
      } catch {
        // Ignore unknown bridge messages.
      }
    });

    socket.once("error", (error) => {
      this.onStatus("disconnected", error.message);
    });

    socket.once("close", () => {
      if (this.socket === socket) this.socket = null;
      this.ready = false;
      if (!this.stopped) this.scheduleReconnect("bridge unavailable");
    });
  }

  private scheduleReconnect(detail: string): void {
    this.onStatus("disconnected", detail);
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, 2_000);
  }
}
