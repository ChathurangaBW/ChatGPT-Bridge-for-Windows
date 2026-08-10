# ChatGPT Bridge for Windows

A VS Code extension that exposes the currently focused workspace to normal ChatGPT conversations through a hosted MCP relay.

> **The VSIX is the only end-user package.** There is no companion EXE, localhost listener, OpenAI API key, ngrok tunnel, tunnel ID, or router configuration.

> **v0.2 is read-only.** It can inspect workspace/editor context, diagnostics, bounded UTF-8 files, and literal workspace search. It cannot edit files, execute shell commands, mutate Git, or run tests.

## User experience

```text
Install ChatGPT Bridge VSIX
          ↓
VS Code opens ChatGPT Bridge setup
          ↓
Extension connects to hosted relay automatically
          ↓
Open ChatGPT → Plugins → ChatGPT Bridge
          ↓
Enter the pairing code shown in VS Code
          ↓
Done — use normal ChatGPT with the open workspace
```

The VS Code setup panel shows relay status, pairing state, the current pairing code, retry controls, and one-click links for pairing/ChatGPT. After the first run, clicking **ChatGPT Bridge** in the status bar reopens the panel.

When ChatGPT calls `get_workspace`, the app can render an inline **Live VS Code workspace** card showing the active file and workspace folders, with a **Refresh from VS Code** action.

## Architecture

```text
VS Code + ChatGPT Bridge VSIX
  ├─ device secret in VS Code SecretStorage
  ├─ first-run setup/status UI
  ├─ six on-demand read-only MCP tools
  ├─ MCP Apps workspace-status UI resource
  └─ outbound authenticated WSS
             │
             ▼
Cloudflare Worker + Durable Objects
  https://lucky-heart-f5b9.chatgpt-bridge.workers.dev
  ├─ product + pairing pages
  ├─ OAuth / PKCE
  ├─ short-lived device pairing codes
  ├─ bearer-protected /mcp
  └─ per-device multi-window relay
             │
             ▼
           ChatGPT
```

The extension does **not** continuously upload editor snapshots. Workspace/editor data is gathered only when ChatGPT invokes one of the MCP tools.

## MCP tools

Exactly six workspace tools are exposed:

- `get_workspace`
- `get_active_editor`
- `get_selection`
- `get_diagnostics`
- `read_file`
- `search_workspace`

`get_workspace` is also linked to the ChatGPT workspace-status UI resource. No additional privileged UI tool is introduced.

## Install

A successful release build produces exactly one end-user package:

```text
chatgpt-bridge-vscode-0.2.0.vsix
```

Install it using **VS Code → Extensions → … → Install from VSIX…**, then reload VS Code. The setup panel opens automatically on first activation.

From source:

```powershell
npm ci
npm run package:release
code --install-extension .\artifacts\chatgpt-bridge-vscode-0.2.0.vsix
```

There is no EXE to start.

## Connect ChatGPT during development

The development MCP endpoint is:

```text
https://lucky-heart-f5b9.chatgpt-bridge.workers.dev/mcp
```

1. Enable ChatGPT **Developer mode**.
2. Open **ChatGPT Plugins** and add a plugin.
3. Use name **ChatGPT Bridge** and the MCP URL above.
4. In VS Code run **ChatGPT Bridge: Open Setup** if the setup panel is not already visible.
5. When ChatGPT opens the Bridge authorization page, enter the pairing code shown in VS Code.
6. Enable ChatGPT Bridge in a normal conversation and ask about the current workspace.

Useful VS Code commands:

- **ChatGPT Bridge: Open Setup**
- **ChatGPT Bridge: Show Status**
- **ChatGPT Bridge: Copy Pairing Code**
- **ChatGPT Bridge: Open Pairing Page**

After an MCP, OAuth, or UI deployment changes, open the ChatGPT Bridge plugin entry in ChatGPT and select **Refresh** so ChatGPT reloads the latest metadata/resources.

## Multiple VS Code windows

All VS Code windows for the same installation can share the paired device identity. Each window opens its own outbound relay socket. The relay sends ChatGPT MCP calls to the most recently focused VS Code window. In-flight requests remain associated with the exact socket that received them.

## Cloud Worker operations

The Cloudflare Worker is operator infrastructure, not an end-user package.

The preferred deployment path is the manual GitHub Actions workflow:

```text
Actions → Deploy ChatGPT Bridge Worker → Run workflow
```

Choose **development** while the project is still being tested. The workflow:

```text
installs dependencies
→ runs repository QA
→ deploys the Worker
→ waits for /health
→ verifies the hosted product UI
→ runs live OAuth/device/MCP smoke
→ verifies the hosted authorization UI
```

This makes deployment status explicit and prevents source changes from silently getting ahead of the deployed Worker.

Operator-only GitHub environment values are described in [`docs/OPERATIONS.md`](docs/OPERATIONS.md). They are deployment credentials and are never entered by VSIX users.

Important Worker routes:

```text
GET  /
GET  /health
GET  /pair/<code>
POST /device/register
GET  /device/status
POST /device/pairing
WS   /device/connect
GET  /.well-known/oauth-protected-resource/mcp
GET  /.well-known/oauth-authorization-server
POST /register
GET  /authorize
POST /authorize
POST /token
POST /mcp
```

## Development and QA

Requirements:

- Node.js 22+
- npm
- VS Code
- Cloudflare account only for Worker deployment

```powershell
git clone https://github.com/ChathurangaBW/ChatGPT-Bridge-for-Windows.git
cd ChatGPT-Bridge-for-Windows
npm ci
npm run qa
npm run package:release
```

CI validates the TypeScript builds, workspace/MCP behavior, Worker runtime, hosted product/authorization UI, multi-window routing, VSIX packaging, and a clean-profile VSIX install/uninstall cycle.

The release artifact upload contains only the VSIX.

## Repository layout

```text
vscode-extension/   complete end-user VSIX client + setup/UI resource
cloud-worker/       hosted OAuth + MCP device relay + product pages
docs/OPERATIONS.md  deployment and ChatGPT connection runbook
bridge/             legacy agent source retained for regression/migration reference; not packaged
.github/workflows/  QA, packaging, and Worker deployment workflows
```

## Security boundary

The v0.2 capability boundary remains unchanged: the six MCP tools are read-only, local workspace access is constrained to open VS Code workspace roots, and there is no shell/write/Git/test-execution tool. See [`SECURITY.md`](SECURITY.md) for the detailed threat model.

## License

No license has been selected yet. Add one before accepting external contributions or redistributing builds outside the intended use.
