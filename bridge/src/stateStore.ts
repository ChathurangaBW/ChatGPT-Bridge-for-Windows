import type { EditorSnapshot } from "./types.js";

export class EditorStateStore {
  private snapshot: EditorSnapshot | null = null;
  private vscodeConnections = 0;

  update(snapshot: EditorSnapshot): void {
    this.snapshot = snapshot;
  }

  getSnapshot(): EditorSnapshot | null {
    return this.snapshot;
  }

  connected(): void {
    this.vscodeConnections += 1;
  }

  disconnected(): void {
    this.vscodeConnections = Math.max(0, this.vscodeConnections - 1);
  }

  isVscodeConnected(): boolean {
    return this.vscodeConnections > 0;
  }
}
