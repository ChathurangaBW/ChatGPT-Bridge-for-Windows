import * as vscode from "vscode";
import { BridgeClient, type BridgeStatus } from "./bridgeClient.js";
import { captureEditorSnapshot } from "./snapshot.js";

const DEFAULT_BRIDGE_PORT = 47321;
const DEBOUNCE_MS = 300;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("ChatGPT Bridge");
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
  status.command = "chatgptBridge.showStatus";
  status.show();

  let currentStatus: BridgeStatus = "disconnected";
  let currentDetail = "Bridge has not connected yet.";
  let debounce: NodeJS.Timeout | null = null;

  const updateStatus = (next: BridgeStatus, detail?: string): void => {
    currentStatus = next;
    currentDetail = detail ?? next;
    if (next === "connected") {
      status.text = "$(plug) ChatGPT Bridge";
      status.tooltip = "Connected to local ChatGPT Bridge service";
    } else if (next === "connecting") {
      status.text = "$(sync~spin) ChatGPT Bridge";
      status.tooltip = "Connecting to local ChatGPT Bridge service";
    } else {
      status.text = "$(debug-disconnect) ChatGPT Bridge";
      status.tooltip = `Disconnected: ${currentDetail}`;
    }
    output.appendLine(`[${new Date().toISOString()}] ${next}${detail ? `: ${detail}` : ""}`);
  };

  const bridgePort = vscode.workspace
    .getConfiguration("chatgptBridge")
    .get<number>("wsPort", DEFAULT_BRIDGE_PORT);
  const client = new BridgeClient(bridgePort, updateStatus);

  const publish = (): void => client.publish(captureEditorSnapshot());
  const schedulePublish = (): void => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      publish();
    }, DEBOUNCE_MS);
  };

  context.subscriptions.push(
    status,
    output,
    vscode.commands.registerCommand("chatgptBridge.showStatus", () => {
      void vscode.window.showInformationMessage(
        `ChatGPT Bridge: ${currentStatus} — ${currentDetail} (ws://127.0.0.1:${bridgePort})`,
      );
    }),
    vscode.window.onDidChangeActiveTextEditor(schedulePublish),
    vscode.window.onDidChangeTextEditorSelection(schedulePublish),
    vscode.workspace.onDidChangeTextDocument(schedulePublish),
    vscode.workspace.onDidChangeWorkspaceFolders(schedulePublish),
    vscode.languages.onDidChangeDiagnostics(schedulePublish),
    { dispose: () => client.stop() },
  );

  client.start();
  publish();
}

export function deactivate(): void {
  // Resources are disposed through ExtensionContext subscriptions.
}
