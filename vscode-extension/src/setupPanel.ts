import * as vscode from "vscode";
import type { CloudStatusDetails } from "./cloudClient.js";
import type { BridgeDiagnostics } from "./connectionDoctor.js";
import type { ReauthenticationPreparation } from "./reauth.js";

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export interface SetupPanelActions {
  copyPairingCode(): Promise<void>;
  copyMcpUrl(): Promise<void>;
  openPairingPage(): Promise<void>;
  openChatGPT(): Promise<void>;
  runDiagnostics(): Promise<BridgeDiagnostics>;
  prepareReauthentication(): Promise<ReauthenticationPreparation>;
  retryConnection(): void;
}

export class SetupPanel implements vscode.Disposable {
  private static current: SetupPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposed = false;
  private status: CloudStatusDetails;
  private diagnostics: BridgeDiagnostics | null = null;
  private diagnosticRunning = false;
  private preparedPairingCode: string | null = null;
  private actionMessage: string | null = null;
  private actionError: string | null = null;

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

    this.panel.webview.onDidReceiveMessage(
      async (message: { type?: unknown }) => {
        this.actionMessage = null;
        this.actionError = null;
        try {
          switch (message.type) {
            case "copy":
              await this.actions.copyPairingCode();
              this.actionMessage = "Pairing code copied.";
              break;
            case "copyMcp":
              await this.actions.copyMcpUrl();
              this.actionMessage = "MCP URL copied.";
              break;
            case "pair":
              await this.actions.openPairingPage();
              break;
            case "chatgpt":
              await this.actions.openChatGPT();
              break;
            case "retry":
              this.actions.retryConnection();
              this.actionMessage = "Relay reconnect requested.";
              break;
            case "doctor":
              this.diagnosticRunning = true;
              this.render();
              this.diagnostics = await this.actions.runDiagnostics();
              this.actionMessage = this.diagnostics.ok
                ? "Bridge endpoint checks passed. If ChatGPT still says reauthentication required, prepare a fresh code below."
                : "One or more Bridge endpoint checks failed. Fix those before reauthenticating ChatGPT.";
              break;
            case "reauth": {
              const prepared = await this.actions.prepareReauthentication();
              this.preparedPairingCode = prepared.pairingCode;
              this.actionMessage = "Fresh pairing code created and copied. In ChatGPT click Reauthenticate, then paste this code and Refresh actions.";
              break;
            }
          }
        } catch (error) {
          this.actionError = error instanceof Error ? error.message : "The requested Bridge action failed.";
        } finally {
          this.diagnosticRunning = false;
          this.render();
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
    const pairedBefore = connected && status.paired === true;
    const needsPairing = connected && status.paired === false && Boolean(status.pairingCode);
    const statusLabel = pairedBefore
      ? "VS Code relay ready"
      : needsPairing
        ? "Ready for ChatGPT authorization"
        : status.status === "connecting"
          ? "Connecting…"
          : "Connection unavailable";
    const statusClass = pairedBefore ? "ok" : needsPairing ? "ready" : status.status === "connecting" ? "working" : "error";
    const statusDetail = pairedBefore
      ? "The VS Code device is connected and has completed OAuth before. ChatGPT app state is checked separately."
      : connected
        ? "The relay is connected. Complete ChatGPT authorization with the pairing code below."
        : status.detail;
    const pairingCode = escapeHtml(this.preparedPairingCode ?? status.pairingCode ?? "");
    const device = escapeHtml(status.deviceId ?? "Not registered yet");
    const diagnostics = this.renderDiagnostics();
    const actionNotice = this.actionError
      ? `<div class="notice errorNotice">${escapeHtml(this.actionError)}</div>`
      : this.actionMessage
        ? `<div class="notice">${escapeHtml(this.actionMessage)}</div>`
        : "";

    this.panel.webview.html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<title>ChatGPT Bridge</title>
<style nonce="${nonce}">
:root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;padding:0;background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);font:13px/1.5 var(--vscode-font-family)}main{max-width:820px;margin:0 auto;padding:42px 28px 64px}.hero{display:flex;align-items:flex-start;gap:18px;margin-bottom:28px}.logo{width:52px;height:52px;border-radius:14px;display:grid;place-items:center;background:var(--vscode-button-background);color:var(--vscode-button-foreground);font-size:27px;font-weight:700}.hero h1{font-size:28px;line-height:1.2;margin:0 0 7px}.muted{color:var(--vscode-descriptionForeground)}.status{display:flex;gap:12px;align-items:center;padding:14px 16px;border:1px solid var(--vscode-widget-border);border-radius:12px;background:var(--vscode-sideBar-background);margin:20px 0 20px}.dot{width:11px;height:11px;border-radius:50%;flex:0 0 auto}.dot.ok{background:var(--vscode-testing-iconPassed)}.dot.ready{background:var(--vscode-charts-yellow)}.dot.working{background:var(--vscode-progressBar-background)}.dot.error{background:var(--vscode-testing-iconFailed)}.status strong{display:block;font-size:14px}.steps{display:grid;gap:14px}.step{border:1px solid var(--vscode-widget-border);border-radius:12px;padding:18px;background:var(--vscode-editorWidget-background)}.step-head{display:flex;gap:11px;align-items:center;margin-bottom:8px}.number{width:26px;height:26px;border-radius:50%;display:grid;place-items:center;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);font-weight:700}.step h2{font-size:15px;margin:0}.code{font:700 27px/1.2 var(--vscode-editor-font-family);letter-spacing:.08em;padding:14px 16px;border:1px solid var(--vscode-input-border);border-radius:9px;background:var(--vscode-input-background);margin:14px 0}.url{font:12px/1.45 var(--vscode-editor-font-family);overflow-wrap:anywhere;padding:10px 12px;border:1px solid var(--vscode-input-border);border-radius:7px;background:var(--vscode-input-background);margin-top:10px}.actions{display:flex;flex-wrap:wrap;gap:9px;margin-top:14px}button{border:1px solid transparent;border-radius:6px;padding:8px 13px;font:inherit;cursor:pointer;background:var(--vscode-button-background);color:var(--vscode-button-foreground)}button:hover{background:var(--vscode-button-hoverBackground)}button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}button.secondary:hover{background:var(--vscode-button-secondaryHoverBackground)}button:disabled{opacity:.55;cursor:default}.notice{margin:0 0 16px;padding:10px 12px;border-radius:8px;border:1px solid var(--vscode-widget-border);background:var(--vscode-textBlockQuote-background)}.errorNotice{border-color:var(--vscode-inputValidation-errorBorder);background:var(--vscode-inputValidation-errorBackground)}.checks{display:grid;gap:8px;margin-top:13px}.check{display:grid;grid-template-columns:12px 180px 1fr;gap:9px;align-items:start}.checkDot{width:9px;height:9px;border-radius:50%;margin-top:5px;background:var(--vscode-descriptionForeground)}.checkDot.pass{background:var(--vscode-testing-iconPassed)}.checkDot.fail{background:var(--vscode-testing-iconFailed)}.check strong{font-size:12px}.callout{margin-top:14px;padding:12px;border-left:3px solid var(--vscode-charts-yellow);background:var(--vscode-textBlockQuote-background)}ol{margin:10px 0 0;padding-left:22px}li{margin:5px 0}.meta{margin-top:28px;padding-top:18px;border-top:1px solid var(--vscode-widget-border);font-size:12px;color:var(--vscode-descriptionForeground)}code{font-family:var(--vscode-editor-font-family);color:var(--vscode-textPreformat-foreground)}
</style>
</head>
<body>
<main>
  <div class="hero">
    <div class="logo">C</div>
    <div><h1>ChatGPT Bridge</h1><div class="muted">Install one VSIX. The extension handles the Bridge relay, pairing, OAuth prerequisites, and troubleshooting. No companion EXE, localhost service, tunnel ID, or OpenAI API key.</div></div>
  </div>

  <div class="status"><span class="dot ${statusClass}"></span><div><strong>${statusLabel}</strong><span class="muted">${escapeHtml(statusDetail)}</span></div></div>
  ${actionNotice}

  <div class="steps">
    <section class="step">
      <div class="step-head"><span class="number">1</span><h2>VS Code client</h2></div>
      <div>${connected ? "The VSIX is running and its outbound relay session is active." : "The extension is installed but its relay session is not currently active."}</div>
      ${connected ? "" : '<div class="actions"><button data-action="retry">Retry relay connection</button></div>'}
    </section>

    <section class="step">
      <div class="step-head"><span class="number">2</span><h2>Check hosted OAuth + MCP configuration</h2></div>
      <div class="muted">This verifies the deployed Worker, OAuth discovery, refresh-token prerequisites, and the protected MCP challenge. It also detects an older Worker deployment.</div>
      <div class="url">https://lucky-heart-f5b9.chatgpt-bridge.workers.dev/mcp</div>
      <div class="actions"><button data-action="doctor" ${this.diagnosticRunning ? "disabled" : ""}>${this.diagnosticRunning ? "Checking…" : "Run connection check"}</button><button class="secondary" data-action="copyMcp">Copy MCP URL</button></div>
      ${diagnostics}
    </section>

    <section class="step">
      <div class="step-head"><span class="number">3</span><h2>${pairedBefore ? "Connect or reauthenticate ChatGPT" : "Authorize ChatGPT"}</h2></div>
      ${pairedBefore
        ? `<div>This VS Code device has completed OAuth before, but the extension cannot read ChatGPT's private app record. If ChatGPT shows <strong>Reauthentication required</strong>, <strong>No app actions available yet</strong>, or <strong>Error refreshing actions</strong>, use the recovery flow below.</div>
           <div class="callout"><strong>Recovery flow</strong><ol><li>Run the connection check above. All four checks should pass.</li><li>Click <strong>Prepare reauthentication</strong>. A fresh pairing code is created and copied.</li><li>In ChatGPT, open the existing VS Code Bridge app and click <strong>Reauthenticate</strong>.</li><li>Paste the pairing code on the Bridge authorization page.</li><li>Back in ChatGPT, click <strong>Refresh actions</strong>.</li></ol></div>
           ${pairingCode ? `<div class="muted" style="margin-top:12px">Pairing code for Connect/Reauthenticate:</div><div class="code">${pairingCode}</div>` : ""}
           <div class="actions"><button data-action="reauth">Prepare reauthentication</button>${pairingCode ? '<button class="secondary" data-action="copy">Copy pairing code</button>' : ""}<button class="secondary" data-action="chatgpt">Open ChatGPT</button></div>`
        : needsPairing
          ? `<div>In ChatGPT, create/connect the existing Bridge app using the MCP URL above. When the OAuth authorization page opens, enter this code:</div><div class="code">${pairingCode}</div><div class="actions"><button data-action="copy">Copy pairing code</button><button class="secondary" data-action="pair">Open pairing page</button><button class="secondary" data-action="chatgpt">Open ChatGPT</button></div>`
          : '<div class="muted">A pairing code will appear as soon as the relay connection is ready.</div>'}
    </section>

    <section class="step">
      <div class="step-head"><span class="number">4</span><h2>ChatGPT account step</h2></div>
      <div class="muted">OpenAI currently requires custom MCP app creation, Reauthenticate, Scan/Refresh actions, and approval inside the signed-in ChatGPT UI. The VSIX prepares every Bridge-side value and opens ChatGPT, but it cannot silently modify your ChatGPT account or approve OAuth on your behalf.</div>
    </section>
  </div>

  <div class="meta">Device: <code>${device}</code><br>Workspace content is fetched only when ChatGPT invokes a Bridge tool.</div>
</main>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
document.addEventListener('click', (event) => {
  const element = event.target instanceof HTMLElement ? event.target.closest('button[data-action]') : null;
  if (!(element instanceof HTMLButtonElement)) return;
  vscode.postMessage({ type: element.dataset.action });
});
</script>
</body>
</html>`;
  }

  private renderDiagnostics(): string {
    if (this.diagnosticRunning) return '<div class="checks muted">Checking hosted Worker and OAuth/MCP metadata…</div>';
    if (!this.diagnostics) return "";
    const summary = this.diagnostics.ok
      ? '<div class="notice" style="margin-top:14px;margin-bottom:0"><strong>Bridge side ready.</strong> Hosted OAuth and MCP prerequisites passed.</div>'
      : '<div class="notice errorNotice" style="margin-top:14px;margin-bottom:0"><strong>Bridge side needs attention.</strong> Do not reauthenticate ChatGPT until the failed checks are fixed.</div>';
    const checks = this.diagnostics.checks.map((check) => `
      <div class="check">
        <span class="checkDot ${check.state}"></span>
        <strong>${escapeHtml(check.label)}</strong>
        <span class="muted">${escapeHtml(check.detail)}</span>
      </div>`).join("");
    return `${summary}<div class="checks">${checks}</div>`;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);
}
