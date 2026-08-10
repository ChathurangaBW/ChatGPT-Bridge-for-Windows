import * as vscode from "vscode";
import type { CloudStatusDetails } from "./cloudClient.js";

export interface SetupPanelActions {
  copyPairingCode(): Promise<void>;
  openPairingPage(): Promise<void>;
  openChatGPT(): Promise<void>;
  retryConnection(): void;
}

export class SetupPanel implements vscode.Disposable {
  private static current: SetupPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposed = false;
  private status: CloudStatusDetails;

  static show(
    context: vscode.ExtensionContext,
    actions: SetupPanelActions,
    status: CloudStatusDetails,
  ): SetupPanel {
    if (SetupPanel.current) {
      SetupPanel.current.status = status;
      SetupPanel.current.panel.reveal(vscode.ViewColumn.One);
      SetupPanel.current.render();
      return SetupPanel.current;
    }

    SetupPanel.current = new SetupPanel(context, actions, status);
    return SetupPanel.current;
  }

  static update(status: CloudStatusDetails): void {
    if (!SetupPanel.current) return;
    SetupPanel.current.status = status;
    SetupPanel.current.render();
  }

  private constructor(
    context: vscode.ExtensionContext,
    private readonly actions: SetupPanelActions,
    status: CloudStatusDetails,
  ) {
    this.status = status;
    this.panel = vscode.window.createWebviewPanel(
      "chatgptBridgeSetup",
      "ChatGPT Bridge",
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.panel.iconPath = new vscode.ThemeIcon("plug");

    this.panel.webview.onDidReceiveMessage(
      async (message: { type?: unknown }) => {
        switch (message.type) {
          case "copy":
            await this.actions.copyPairingCode();
            break;
          case "pair":
            await this.actions.openPairingPage();
            break;
          case "chatgpt":
            await this.actions.openChatGPT();
            break;
          case "retry":
            this.actions.retryConnection();
            break;
        }
      },
      undefined,
      context.subscriptions,
    );

    this.panel.onDidDispose(() => this.dispose(), undefined, context.subscriptions);
    this.render();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (SetupPanel.current === this) SetupPanel.current = undefined;
  }

  private render(): void {
    if (this.disposed) return;
    const nonce = String(Date.now());
    const status = this.status;
    const connected = status.status === "connected";
    const paired = connected && status.paired === true;
    const needsPairing = connected && status.paired === false && Boolean(status.pairingCode);
    const statusLabel = paired
      ? "Connected to ChatGPT"
      : needsPairing
        ? "Ready to pair"
        : status.status === "connecting"
          ? "Connecting…"
          : "Connection unavailable";
    const statusClass = paired ? "ok" : needsPairing ? "ready" : status.status === "connecting" ? "working" : "error";
    const pairingCode = escapeHtml(status.pairingCode ?? "");
    const device = escapeHtml(status.deviceId ?? "Not registered yet");
    const detail = escapeHtml(status.detail);

    this.panel.webview.html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<title>ChatGPT Bridge</title>
<style nonce="${nonce}">
:root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;padding:0;background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);font:13px/1.5 var(--vscode-font-family)}main{max-width:760px;margin:0 auto;padding:42px 28px 64px}.hero{display:flex;align-items:flex-start;gap:18px;margin-bottom:28px}.logo{width:52px;height:52px;border-radius:14px;display:grid;place-items:center;background:var(--vscode-button-background);color:var(--vscode-button-foreground);font-size:27px;font-weight:700}.hero h1{font-size:28px;line-height:1.2;margin:0 0 7px}.muted{color:var(--vscode-descriptionForeground)}.status{display:flex;gap:12px;align-items:center;padding:14px 16px;border:1px solid var(--vscode-widget-border);border-radius:12px;background:var(--vscode-sideBar-background);margin:20px 0 26px}.dot{width:11px;height:11px;border-radius:50%;flex:0 0 auto}.dot.ok{background:var(--vscode-testing-iconPassed)}.dot.ready{background:var(--vscode-charts-yellow)}.dot.working{background:var(--vscode-progressBar-background)}.dot.error{background:var(--vscode-testing-iconFailed)}.status strong{display:block;font-size:14px}.steps{display:grid;gap:14px}.step{border:1px solid var(--vscode-widget-border);border-radius:12px;padding:18px;background:var(--vscode-editorWidget-background)}.step-head{display:flex;gap:11px;align-items:center;margin-bottom:8px}.number{width:26px;height:26px;border-radius:50%;display:grid;place-items:center;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);font-weight:700}.step h2{font-size:15px;margin:0}.code{font:700 27px/1.2 var(--vscode-editor-font-family);letter-spacing:.08em;padding:14px 16px;border:1px solid var(--vscode-input-border);border-radius:9px;background:var(--vscode-input-background);margin:14px 0}.actions{display:flex;flex-wrap:wrap;gap:9px;margin-top:14px}button{border:1px solid transparent;border-radius:6px;padding:8px 13px;font:inherit;cursor:pointer;background:var(--vscode-button-background);color:var(--vscode-button-foreground)}button:hover{background:var(--vscode-button-hoverBackground)}button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}button.secondary:hover{background:var(--vscode-button-secondaryHoverBackground)}button:disabled{opacity:.55;cursor:default}.meta{margin-top:28px;padding-top:18px;border-top:1px solid var(--vscode-widget-border);font-size:12px;color:var(--vscode-descriptionForeground)}code{font-family:var(--vscode-editor-font-family);color:var(--vscode-textPreformat-foreground)}
</style>
</head>
<body>
<main>
  <div class="hero">
    <div class="logo">C</div>
    <div><h1>ChatGPT Bridge</h1><div class="muted">Use your current VS Code workspace directly from normal ChatGPT. No companion EXE, localhost service, tunnel ID, or OpenAI API key.</div></div>
  </div>

  <div class="status"><span class="dot ${statusClass}"></span><div><strong>${statusLabel}</strong><span class="muted">${detail}</span></div></div>

  <div class="steps">
    <section class="step">
      <div class="step-head"><span class="number">1</span><h2>VS Code extension installed</h2></div>
      <div class="muted">This extension contains the complete Windows client and connects outward to the hosted relay automatically.</div>
    </section>

    <section class="step">
      <div class="step-head"><span class="number">2</span><h2>Connect this VS Code to the relay</h2></div>
      <div>${connected ? "Relay connection is active." : "The extension will retry automatically. You can also retry now."}</div>
      ${connected ? "" : '<div class="actions"><button data-action="retry">Retry connection</button></div>'}
    </section>

    <section class="step">
      <div class="step-head"><span class="number">3</span><h2>Connect ChatGPT</h2></div>
      ${paired
        ? '<div><strong>Done.</strong> ChatGPT is authorized for this VS Code device. In ChatGPT, enable the ChatGPT Bridge plugin for the conversation and ask about the workspace.</div><div class="actions"><button data-action="chatgpt">Open ChatGPT</button></div>'
        : needsPairing
          ? `<div>In ChatGPT, connect <strong>ChatGPT Bridge</strong>. When the authorization page opens, enter this code:</div><div class="code">${pairingCode}</div><div class="actions"><button data-action="copy">Copy pairing code</button><button class="secondary" data-action="pair">Open pairing page</button><button class="secondary" data-action="chatgpt">Open ChatGPT</button></div>`
          : '<div class="muted">A pairing code will appear here as soon as the relay connection is ready.</div>'}
    </section>
  </div>

  <div class="meta">Device: <code>${device}</code><br>Workspace content is fetched only when ChatGPT invokes a Bridge tool.</div>
</main>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
document.addEventListener('click', (event) => {
  const target = event.target instanceof HTMLElement ? event.target.closest('button[data-action]') : null;
  if (!target) return;
  vscode.postMessage({ type: target.dataset.action });
});
</script>
</body>
</html>`;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}
