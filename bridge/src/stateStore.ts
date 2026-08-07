import type { EditorSnapshot } from "./types.js";

interface SessionState {
  snapshot: EditorSnapshot | null;
  sequence: number;
}

export class EditorStateStore {
  private readonly sessions = new Map<string, SessionState>();
  private activeSessionId: string | null = null;
  private sequence = 0;

  connected(sessionId: string): void {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, { snapshot: null, sequence: 0 });
    }
  }

  update(sessionId: string, snapshot: EditorSnapshot): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("Cannot update a disconnected VS Code session.");

    session.snapshot = snapshot;
    session.sequence = ++this.sequence;
    this.activeSessionId = sessionId;
  }

  getSnapshot(): EditorSnapshot | null {
    if (!this.activeSessionId) return null;
    return this.sessions.get(this.activeSessionId)?.snapshot ?? null;
  }

  disconnected(sessionId: string): void {
    const wasActive = this.activeSessionId === sessionId;
    this.sessions.delete(sessionId);
    if (!wasActive) return;

    let nextSessionId: string | null = null;
    let newestSequence = -1;
    for (const [candidateId, session] of this.sessions) {
      if (session.snapshot && session.sequence > newestSequence) {
        nextSessionId = candidateId;
        newestSequence = session.sequence;
      }
    }
    this.activeSessionId = nextSessionId;
  }

  isVscodeConnected(): boolean {
    return this.sessions.size > 0;
  }
}
