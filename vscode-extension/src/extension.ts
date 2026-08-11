import * as vscode from "vscode";
import { CloudExtensionClient, type CloudStatusDetails } from "./cloudClient.js";
import { BRIDGE_MCP_URL, BRIDGE_ORIGIN, runBridgeDiagnostics } from "./connectionDoctor.js";
import { prepareChatGptReauthentication } from "./reauth.js";
import { SetupPanel, type SetupPanelActions } from "./setupPanel.js";

const SETUP_SHOWN_KEY = "chatgptBridge.setupShown.v2";
const CHATGPT_URL = "https://chatgpt.com/";

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
        statusBar.tooltip = "Relay ready. Click to authorize ChatGPT or troubleshoot reauthentication.";
      } else {
        statusBar.text = "$(plug) ChatGPT Bridge";
        statusBar.tooltip = "VS Code relay is connected. Click for ChatGPT setup, diagnostics, and reauthentication.";
      }
    } else if (details.status === "connecting") {
      statusBar.text = "$(sync~spin) ChatGPT Bridge";
      statusBar.tooltip = details.detail;
    } else {
      statusBar.text = "$(debug-disconnect) ChatGPT Bridge";
      statusBar.tooltip = `${details.detail} Click to troubleshoot.`;
    }

    output.appendLine(`[${new Date().toISOString()}] ${details.status}: ${details.detail}`);
    if (details.pairingCode && details.paired === false) output.appendLine(`Pairing code available: ${details.pairingCode}`);
  };

  const client = new CloudExtensionClient(context, updateStatus);

  const actions: SetupPanelActions = {
    copyPairingCode: () => client.copyPairingCode(),
    copyMcpUrl: async () => {
      await vscode.env.clipboard.writeText(BRIDGE_MCP_URL);
    },
    openPairingPage: () => client.openPairingPage(),
    openChatGPT: async () => {
      await vscode.env.openExternal(vscode.Uri.parse(CHATGPT_URL));
    },
    runDiagnostics: async () => {
      output.appendLine(`[${new Date().toISOString()}] running hosted Worker/OAuth/MCP connection check`);
      const result = await runBridgeDiagnostics(fetch, BRIDGE_ORIGIN, latest.pairingCode);
      for (const check of result.checks) {
        output.appendLine(`  ${check.state.toUpperCase()} ${check.label}: ${check.detail}`);
      }
      return result;
    },
    prepareReauthentication: async () => {
      output.appendLine(`[${new Date().toISOString()}] preparing fresh ChatGPT reauthentication pairing code`);
      const prepared = await prepareChatGptReauthentication(context);
      output.appendLine("Fresh pairing code prepared and copied to clipboard.");
      return prepared;
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
      const relayState = latest.status === "connected"
        ? latest.paired === false
          ? "Relay connected; ChatGPT authorization required"
          : "Relay connected; device authorized previously"
        : latest.detail;
      const selected = await vscode.window.showInformationMessage(
        `ChatGPT Bridge — ${relayState}`,
        "Open Setup",
        "Run Connection Check",
      );
      if (selected === "Open Setup") openSetup();
      if (selected === "Run Connection Check") {
        openSetup();
        const result = await actions.runDiagnostics();
        void vscode.window.showInformationMessage(result.ok ? "ChatGPT Bridge endpoint checks passed." : "ChatGPT Bridge endpoint checks found a problem. Open Setup for details.");
      }
    }),
    vscode.commands.registerCommand("chatgptBridge.copyPairingCode", () => client.copyPairingCode()),
    vscode.commands.registerCommand("chatgptBridge.openPairingPage", () => client.openPairingPage()),
    vscode.commands.registerCommand("chatgptBridge.runConnectionCheck", async () => {
      const result = await actions.runDiagnostics();
      openSetup();
      void vscode.window.showInformationMessage(result.ok ? "ChatGPT Bridge endpoint checks passed." : "ChatGPT Bridge endpoint checks found a problem. Open Setup for details.");
    }),
    vscode.commands.registerCommand("chatgptBridge.prepareReauthentication", async () => {
      const prepared = await actions.prepareReauthentication();
      openSetup();
      void vscode.window.showInformationMessage(`Fresh pairing code ${prepared.pairingCode} copied. In ChatGPT click Reauthenticate, authorize, then Refresh actions.`);
    }),
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
