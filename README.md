# ChatGPT Bridge for Windows

A VS Code extension that exposes the currently focused workspace to normal ChatGPT conversations through a hosted MCP relay.

> **The VSIX is the only end-user package.** There is no companion EXE, localhost listener, OpenAI API key, ngrok tunnel, tunnel ID, or router configuration.

> **v0.2 remains deliberately read-only.** It can inspect workspace/editor context, diagnostics, bounded UTF-8 files, and literal workspace search. It cannot edit files, execute shell commands, mutate Git, or run tests.

## Architecture

```text
VS Code + ChatGPT Bridge VSIX
  ├─ encrypted device secret in VS Code SecretStorage
  ├─ on-demand read-only MCP tools
  ├─ canonical workspace privacy checks
  └─ outbound authenticated WSS
             │
             ▼
Cloudflare Worker + Durable Objects
  https://lucky-heart-f5b9.chatgpt-bridge.workers.dev
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

- `get_workspace`
- `get_active_editor`
- `get_selection`
- `get_diagnostics`
- `read_file`
- `search_workspace`

Active-editor and selection data is returned only when the file resolves canonically inside a currently open VS Code workspace root. File reads reject files outside the workspace, symlink escapes, binary-looking data, invalid UTF-8, and files over the configured read limit. Search is literal and bounded and skips common dependency/build directories.

## Install

A successful release build produces exactly one end-user package:

```text
chatgpt-bridge-vscode-0.2.0.vsix
```

Install it using **VS Code → Extensions → … → Install from VSIX…**, then reload VS Code.

From source:

```powershell
npm ci
npm run package:release
code --install-extension .\artifacts\chatgpt-bridge-vscode-0.2.0.vsix
```

There is no EXE to start.

## Pair ChatGPT

The public MCP endpoint is:

```text
https://lucky-heart-f5b9.chatgpt-bridge.workers.dev/mcp
```

After installing the VSIX, run **ChatGPT Bridge: Show Status**. The extension automatically connects to the hosted relay. If the device is not yet authorized, the status bar shows a short pairing code.

When ChatGPT opens the Bridge OAuth authorization page, enter that pairing code and approve the connection.

The extension stores the device secret in VS Code `SecretStorage`. If an older EXE-based v0.2 installation is present, the extension can import its existing device credential once so the existing ChatGPT OAuth authorization can continue without the EXE.

Useful commands:

- **ChatGPT Bridge: Show Status**
- **ChatGPT Bridge: Copy Pairing Code**
- **ChatGPT Bridge: Open Pairing Page**

## Multiple VS Code windows

All VS Code windows for the same installation can share the paired device identity. Each window opens its own outbound relay socket. The Durable Object tracks focus events and sends ChatGPT MCP calls to the most recently focused VS Code window. In-flight requests are bound to the exact socket that received them so a stale/replaced window cannot answer a newer request.

## Cloud Worker

The Cloudflare Worker is operator infrastructure, not an end-user package.

Important routes:

```text
GET  /health
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

Operator deployment:

```powershell
npm ci
npx wrangler login
npm run deploy:cloud
```

## Security boundary

### VS Code extension

- No localhost server or open local port.
- Device secret is stored with VS Code `SecretStorage`, not plaintext extension state.
- Workspace data is read only on MCP tool invocation.
- Canonical real paths enforce the workspace boundary and block symlink escapes.
- Active files outside the workspace are withheld.
- Text reads are bounded and require valid UTF-8.
- Search is bounded and skips dependency/generated directories.
- No write/edit/shell/Git/test-execution MCP tools exist.

### Cloud relay

- VS Code connects outbound over authenticated WSS.
- Device secrets are capability tokens; only their hash is stored in the control plane.
- OAuth uses PKCE S256 and short-lived single-use authorization codes.
- Refresh tokens rotate and cannot broaden the granted scope.
- OAuth/device endpoints are body-bounded and rate-limited.
- `/mcp` requires a bearer token for the exact MCP resource.
- Multiple sockets may exist for one device, with a strict per-device cap.
- MCP requests route to the most recently focused VS Code window.
- In-flight responses are correlated to the exact selected socket.
- Relay request/response bodies and headers are bounded.

See `SECURITY.md` for the detailed threat model.

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

CI runs deterministic install, dependency audit, TypeScript checks/builds, read-only bridge/Worker regression tests, a real `workerd` OAuth/MCP relay smoke, focused multi-window routing smoke, VSIX packaging, and a packaged-VSIX inspection that fails if an EXE or the removed localhost bridge endpoint is present.

The release artifact upload contains only the VSIX.

## Repository layout

```text
vscode-extension/   complete end-user VSIX client
cloud-worker/       hosted OAuth + MCP device relay
bridge/             legacy v0.1/v0.2 agent source retained for regression/migration reference; not packaged
.github/workflows/  deterministic QA and VSIX-only release gate
```

## License

No license has been selected yet. Add one before accepting external contributions or redistributing builds outside the intended use.
