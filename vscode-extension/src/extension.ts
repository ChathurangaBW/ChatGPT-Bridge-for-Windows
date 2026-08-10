import * as vscode from "vscode";
import { CloudExtensionClient, type CloudStatusDetails } from "./cloudClient.js";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("ChatGPT Bridge");
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
  statusBar.command = "chatgptBridge.showStatus";
  statusBar.show();

  let latest: CloudStatusDetails = { status: "disconnected", detail: "Not connected yet." };

  const updateStatus = (details: CloudStatusDetails): void => {
    latest = details;
    if (details.status === "connected") {
      if (details.paired === false && details.pairingCode) {
        statusBar.text = `$(key) ChatGPT Bridge: ${details.pairingCode}`;
        statusBar.tooltip = "Cloud relay connected. Use this pairing code when ChatGPT asks you to authorize the VS Code bridge.";
      } else {
        statusBar.text = "$(plug) ChatGPT Bridge";
        statusBar.tooltip = "VS Code is connected directly to the ChatGPT Bridge cloud relay.";
      }
    } else if (details.status === "connecting") {
      statusBar.text = "$(sync~spin) ChatGPT Bridge";
      statusBar.tooltip = details.detail;
    } else {
      statusBar.text = "$(debug-disconnect) ChatGPT Bridge";
      statusBar.tooltip = details.detail;
    }
    output.appendLine(`[${new Date().toISOString()}] ${details.status}: ${details.detail}`);
    if (details.pairingCode) output.appendLine(`Pairing code: ${details.pairingCode}`);
  };

  const client = new CloudExtensionClient(context, updateStatus);

  context.subscriptions.push(
    statusBar,
    output,
    client,
    vscode.commands.registerCommand("chatgptBridge.showStatus", async () => {
      const lines = [
        `ChatGPT Bridge: ${latest.status}`,
        latest.detail,
        latest.deviceId ? `Device: ${latest.deviceId}` : "",
        latest.pairingCode && latest.paired === false ? `Pairing code: ${latest.pairingCode}` : "",
      ].filter(Boolean);
      const actions = latest.pairingCode && latest.paired === false ? ["Copy Pairing Code", "Open Pairing Page"] : [];
      const selected = await vscode.window.showInformationMessage(lines.join(" — "), ...actions);
      if (selected === "Copy Pairing Code") await client.copyPairingCode();
      if (selected === "Open Pairing Page") await client.openPairingPage();
    }),
    vscode.commands.registerCommand("chatgptBridge.copyPairingCode", () => client.copyPairingCode()),
    vscode.commands.registerCommand("chatgptBridge.openPairingPage", () => client.openPairingPage()),
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) client.announceFocus();
    }),
  );

  client.start();
}

export function deactivate(): void {
  // Resources are disposed through ExtensionContext subscriptions.
}
