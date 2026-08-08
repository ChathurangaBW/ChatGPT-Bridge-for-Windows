# ChatGPT Bridge for Windows — VS Code Extension

This extension publishes live VS Code editor context to the **local** ChatGPT Bridge service over an authenticated loopback WebSocket.

It can publish locally to the Bridge service:

- active file metadata;
- the current editor buffer, including unsaved text (bounded by size limits);
- the current selection;
- open workspace folders;
- VS Code diagnostics for files inside those workspaces.

The extension does **not** connect directly to ChatGPT or the public internet. It expects the companion Bridge service to be running on the same Windows machine. By default it connects to `ws://127.0.0.1:47321` and authenticates with the pairing secret stored by the Bridge service under `%LOCALAPPDATA%\ChatGPTBridge\bridge-token`.

The Bridge service is the final MCP privacy boundary. Before active-editor or selection data is returned to ChatGPT, the Bridge resolves the active file canonically and withholds the path, buffer, and selection unless the file is inside a currently open workspace root. Snapshots are also isolated per authenticated VS Code window so closing one window cannot leave its editor state exposed through another connection.

## Install from VSIX

Build the extension package from the repository root with:

```powershell
npm run package:vscode
```

Then in VS Code use **Extensions → … → Install from VSIX…** and select `artifacts\chatgpt-bridge-vscode-0.1.0.vsix`.

If the Bridge WebSocket port is customized, change **ChatGPT Bridge for Windows: WS Port** (`chatgptBridge.wsPort`) in VS Code settings and reload the extension.

Version 0.1 is deliberately read-only: it publishes context but does not apply edits, save files, or execute commands.
