# ChatGPT Bridge for Windows — VS Code Extension

ChatGPT Bridge runs entirely inside VS Code. The **VSIX is the only end-user package**; there is no companion EXE, localhost MCP server, local WebSocket port, ngrok tunnel, tunnel ID, or OpenAI API key.

The extension opens an outbound authenticated WebSocket to the hosted ChatGPT Bridge relay and handles MCP requests inside the currently focused VS Code window.

## First-run setup and connection doctor

After installation/reload, the extension automatically opens the **ChatGPT Bridge** setup panel once.

The panel separates the real connection layers instead of treating an old device pairing as proof that the current ChatGPT app session is healthy:

1. VS Code client / relay connection.
2. Hosted Worker + OAuth + MCP configuration check.
3. ChatGPT authorization or reauthentication.
4. Final ChatGPT account action (Reauthenticate / Refresh actions) when required.

The **Run connection check** action validates:

- hosted Worker `/health`
- OAuth protected-resource discovery
- OAuth authorization-server metadata, PKCE, refresh-token and `offline_access` support
- a real authorization redirect using the current pairing code, including the expected OAuth issuer marker
- unauthenticated `/mcp` returning the expected OAuth challenge

This lets the extension identify a stale or incompatible Worker deployment before the user retries ChatGPT authorization.

When ChatGPT reports **Reauthentication required**, **No app actions available yet**, or **Error refreshing actions**:

1. Open **ChatGPT Bridge: Open Setup**.
2. Run **Run connection check** and resolve any failed Bridge-side check.
3. Click **Prepare reauthentication**. The extension rotates a fresh pairing code and copies it to the clipboard.
4. In the existing ChatGPT Bridge app entry, click **Reauthenticate**.
5. Paste the fresh pairing code on the Bridge OAuth page.
6. Back in ChatGPT, click **Refresh actions**.

OpenAI currently performs custom MCP app creation, OAuth approval, Reauthenticate, and Scan/Refresh actions inside the signed-in ChatGPT UI. The VSIX prepares and validates every Bridge-side value but does not attempt to impersonate or modify the user's ChatGPT account.

Other setup actions include:

- **Copy pairing code**
- **Copy MCP URL**
- **Open pairing page**
- **Open ChatGPT**
- **Retry relay connection**

The ChatGPT Bridge status-bar item remains available after first run. Click it at any time to reopen setup.

Commands:

- **ChatGPT Bridge: Open Setup**
- **ChatGPT Bridge: Show Status**
- **ChatGPT Bridge: Copy Pairing Code**
- **ChatGPT Bridge: Open Pairing Page**
- **ChatGPT Bridge: Run Connection Check**
- **ChatGPT Bridge: Prepare ChatGPT Reauthentication**

## ChatGPT UI

`get_workspace` advertises an MCP Apps UI resource. In compatible ChatGPT conversations the tool result can render an inline **Live VS Code workspace** card showing:

- whether VS Code is connected
- the active workspace file
- current workspace folders
- **Refresh from VS Code**

The card uses the existing `get_workspace` tool; it does not add another privileged tool.

## Read-only tools

The extension exposes exactly six MCP tools through the relay:

- `get_workspace`
- `get_active_editor`
- `get_selection`
- `get_diagnostics`
- `read_file`
- `search_workspace`

Editor/file data is read only when ChatGPT invokes a tool. The extension does not continuously upload the editor buffer.

The extension does not edit files, save files, execute shell commands, run tests, or mutate Git.

## Pairing and credentials

On first activation the extension registers a device with the hosted relay. If the device has not been authorized, the setup panel and status bar display its pairing code. When ChatGPT opens the Bridge OAuth authorization page, enter that code.

The long-lived device secret is stored in VS Code `SecretStorage`. Device metadata is stored in VS Code global extension state. If the previous EXE-based v0.2 bridge credential is present, the extension imports it once so an existing ChatGPT authorization can continue without the EXE.

Multiple VS Code windows may use the same paired device. The relay routes new MCP calls to the most recently focused VS Code window.

## Install

Build from the repository root:

```powershell
npm ci
npm run package:release
```

The only release artifact is:

```text
artifacts/chatgpt-bridge-vscode-0.2.0.vsix
```

Install it with **VS Code → Extensions → … → Install from VSIX…**, then reload VS Code. No separate program needs to be started.
