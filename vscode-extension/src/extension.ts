import * as vscode from "vscode";
import { CloudExtensionClient, type CloudStatusDetails } from "./cloudClient.js";
import { SetupPanel, type SetupPanelActions } from "./setupPanel.js";

const SETUP_SHOWN_KEY = "chatgptBridge.setupShown.v2";
const CHATGPT_PLUGINS_URL = "https://chatgpt.com/plugins";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("ChatGPT Bridge");
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
  statusBar.command = "chatgptBridge.openSetup";
  statusBar.show();

  let latest: CloudStatusDetails = { status: "disconnected", detail: "Not connected yet." };

  const updateStatus = (details: CloudStatusDetails): void => {
    latest = details;
    SetupPanel.update(details);

    if (details.status === "connected") {
      if (details.paired === false && details.pairingCode) {
        statusBar.text = `$(key) ChatGPT Bridge: ${details.pairingCode}`;
        statusBar.tooltip = "Ready to pair with ChatGPT. Click to open setup.";
      } else {
        statusBar.text = "$(plug) ChatGPT Bridge";
        statusBar.tooltip = "Connected to the ChatGPT Bridge relay. Click for setup and status.";
      }
    } else if (details.status === "connecting") {
      statusBar.text = "$(sync~spin) ChatGPT Bridge";
      statusBar.tooltip = details.detail;
    } else {
      statusBar.text = "$(debug-disconnect) ChatGPT Bridge";
      statusBar.tooltip = `${details.detail} Click to troubleshoot.`;
    }

    output.appendLine(`[${new Date().toISOString()}] ${details.status}: ${details.detail}`);
    if (details.pairingCode) output.appendLine(`Pairing code: ${details.pairingCode}`);
  };

  const client = new CloudExtensionClient(context, updateStatus);

  const actions: SetupPanelActions = {
    copyPairingCode: () => client.copyPairingCode(),
    openPairingPage: () => client.openPairingPage(),
    openChatGPT: async () => {
      await vscode.env.openExternal(vscode.Uri.parse(CHATGPT_PLUGINS_URL));
    },
    retryConnection: () => {
      output.appendLine(`[${new Date().toISOString()}] manual retry requested`);
      client.stop();
      client.start();
    },
  };

  const openSetup = (): void => {
    SetupPanel.show(context, actions, latest);
  };

  context.subscriptions.push(
    statusBar,
    output,
    client,
    vscode.commands.registerCommand("chatgptBridge.openSetup", openSetup),
    vscode.commands.registerCommand("chatgptBridge.showStatus", async () => {
      const lines = [
        `ChatGPT Bridge: ${latest.status}`,
        latest.detail,
        latest.pairingCode && latest.paired === false ? `Pairing code: ${latest.pairingCode}` : "",
      ].filter(Boolean);
      const selected = await vscode.window.showInformationMessage(lines.join(" — "), "Open Setup");
      if (selected === "Open Setup") openSetup();
    }),
    vscode.commands.registerCommand("chatgptBridge.copyPairingCode", () => client.copyPairingCode()),
    vscode.commands.registerCommand("chatgptBridge.openPairingPage", () => client.openPairingPage()),
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) client.announceFocus();
    }),
  );

  client.start();

  if (!context.globalState.get<boolean>(SETUP_SHOWN_KEY)) {
    openSetup();
    void context.globalState.update(SETUP_SHOWN_KEY, true);
  }
}

export function deactivate(): void {
  // Resources are disposed through ExtensionContext subscriptions.
}
