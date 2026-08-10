# ChatGPT Bridge for Windows

Windows-first bridge that exposes **live VS Code editor context** to normal ChatGPT conversations through MCP, without using Codex as the user-facing workflow.

> **v0.2 remains deliberately read-only.** It exposes workspace/editor context, diagnostics, safe UTF-8 file reads, and bounded literal search. It does not edit files, run commands, mutate Git, or execute tests on behalf of ChatGPT.

## v0.2 architecture

```text
VS Code
  │ authenticated loopback WebSocket
  ▼
ChatGPTBridge.exe
  ├─ live editor state
  ├─ safe workspace reads/search
  ├─ localhost MCP: http://127.0.0.1:47322/mcp
  └─ outbound authenticated WebSocket
             │
             ▼
Cloudflare Worker + Durable Objects
https://lucky-heart-f5b9.chatgpt-bridge.workers.dev
  ├─ OAuth discovery / registration / PKCE
  ├─ short-lived PC pairing codes
  ├─ bearer-protected /mcp
  └─ per-device WebSocket relay
             │
             ▼
           ChatGPT
```

The normal user does **not** enter an OpenAI API key, tunnel ID, ngrok URL, or router/firewall rule. `ChatGPTBridge.exe` makes the connection outbound and stores its own device credential locally. ChatGPT authenticates to the public MCP endpoint through OAuth and the user authorizes a PC with the short pairing code displayed by the bridge.

## MCP tools

The bridge exposes six read-only tools:

- `get_workspace`
- `get_active_editor`
- `get_selection`
- `get_diagnostics`
- `read_file`
- `search_workspace`

Active editor/selection data is returned only when the active file resolves canonically inside a currently open VS Code workspace root.

## Public endpoint

The configured Worker is:

```text
https://lucky-heart-f5b9.chatgpt-bridge.workers.dev
```

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

The MCP endpoint to register in ChatGPT is:

```text
https://lucky-heart-f5b9.chatgpt-bridge.workers.dev/mcp
```

## Deploy the Cloudflare Worker

Deployment is an operator/developer step. End users of the packaged bridge do not need a Cloudflare account.

From the repository root:

```powershell
npm ci
npx wrangler login
npm run deploy:cloud
```

`wrangler login` uses Cloudflare's browser authorization flow. No OpenAI API key is involved.

Verify deployment:

```powershell
Invoke-RestMethod https://lucky-heart-f5b9.chatgpt-bridge.workers.dev/health
```

Expected service version: `0.2.0`.

## Install on Windows

A successful CI run produces artifact **`chatgpt-bridge-windows-0.2.0`** containing:

```text
ChatGPTBridge.exe
chatgpt-bridge-vscode-0.2.0.vsix
```

`ChatGPTBridge.exe` contains its Node runtime. The current build is unsigned, so Windows may display a SmartScreen warning.

### 1. Start the bridge

```powershell
.\ChatGPTBridge.exe
```

Defaults:

```text
VS Code socket: ws://127.0.0.1:47321
Local MCP:      http://127.0.0.1:47322/mcp
Health:         http://127.0.0.1:47322/health
Cloud gateway:  https://lucky-heart-f5b9.chatgpt-bridge.workers.dev
```

On first start the agent registers a device and prints a short pairing code similar to:

```text
Cloud pairing:    ABCD-EFGH-JKLM
Pairing page:     https://lucky-heart-f5b9.chatgpt-bridge.workers.dev/pair/ABCD-EFGH-JKLM
```

Cloud device credentials are stored under the current Windows user's `%LOCALAPPDATA%\ChatGPTBridge` directory. They are separate from the local VS Code pairing secret.

Optional environment variables:

```text
BRIDGE_WS_PORT=47321
BRIDGE_MCP_PORT=47322
BRIDGE_CLOUD_URL=https://lucky-heart-f5b9.chatgpt-bridge.workers.dev
BRIDGE_CLOUD_DISABLED=true
```

`BRIDGE_CLOUD_DISABLED=true` is for local/offline diagnostics and CI.

### 2. Install the VS Code extension

```powershell
code --install-extension .\chatgpt-bridge-vscode-0.2.0.vsix
```

Or use **VS Code → Extensions → … → Install from VSIX…**.

Restart VS Code, open the project folder, then run **ChatGPT Bridge: Show Status** from the Command Palette. The local health check should report `vscodeConnected: true`:

```powershell
Invoke-RestMethod http://127.0.0.1:47322/health
```

### 3. Connect the ChatGPT app

Create/configure the custom MCP app in ChatGPT with:

```text
https://lucky-heart-f5b9.chatgpt-bridge.workers.dev/mcp
```

The endpoint returns OAuth protected-resource metadata. During **Connect**, ChatGPT is redirected to the bridge authorization page. Enter the current pairing code shown by `ChatGPTBridge.exe` and approve the PC. OAuth uses authorization-code + PKCE; access and refresh tokens are issued by the Worker and scoped to `bridge:read`.

If the ChatGPT app is recreated or authorization needs to be repeated later, the running Windows agent continually maintains a fresh short-lived pairing code. You do not delete the device credential or enter an OpenAI API key.

## Local security boundary

- Local VS Code and MCP listeners bind only to `127.0.0.1`.
- VS Code → bridge requires a generated per-user secret.
- Editor snapshots are schema-validated and bounded.
- Multiple VS Code windows have isolated snapshots.
- Active-file/selection data is rechecked against canonical workspace roots at the MCP boundary.
- Safe file reads/search reject symlink escapes, invalid UTF-8, binary-looking data, generated/dependency directories, and oversized files.
- No arbitrary shell, write/edit, Git mutation, or test-execution MCP tool exists.

## Cloud security boundary

- Windows → cloud is outbound WSS only.
- Device secrets are random capabilities; only a hash is stored in the Worker control plane.
- OAuth uses PKCE S256 and short-lived, single-use authorization codes.
- Pairing codes are short-lived and generation-bound so a stale OAuth callback cannot authorize after a newer pairing rotation.
- Refresh tokens rotate and cannot broaden the originally granted scope.
- OAuth/device registration endpoints are rate-limited and body-bounded.
- `/mcp` requires a valid bearer token for the exact MCP resource.
- Each device has an isolated Durable Object relay and only one active bridge socket is retained.
- Relay request/response bodies and forwarded headers are bounded/allowlisted.

See [SECURITY.md](SECURITY.md) for the detailed threat boundary.

## Development

Requirements:

- Node.js 22+
- npm
- VS Code
- Cloudflare account only when deploying the Worker

```powershell
git clone https://github.com/ChathurangaBW/ChatGPT-Bridge-for-Windows.git
cd ChatGPT-Bridge-for-Windows
npm ci
npm run qa
```

Useful commands:

```powershell
npm run dev:bridge
npm run dev:cloud
npm run package:release
npm run deploy:cloud
```

Repository layout:

```text
bridge/             Windows agent + localhost MCP/security boundary
vscode-extension/   live VS Code context publisher
cloud-worker/       OAuth control plane + per-device relay
.github/workflows/  Windows deterministic QA/release gate
```

## QA gate

CI uses the committed npm lockfile and read-only repository permissions. It runs:

- `npm ci`
- blocking `npm audit --audit-level=moderate`
- TypeScript checks and builds for all workspaces
- bridge and Worker unit tests
- Worker dry-run packaging
- real local `workerd` runtime smoke covering device registration, authenticated WebSocket relay, OAuth dynamic client registration, PKCE token exchange, bearer `/mcp`, MCP response relay, and refresh-token rotation
- VSIX packaging
- standalone Windows EXE packaging
- packaged EXE health/startup smoke
- occupied-port and malformed-port failure checks

The only step not reproducible in public CI is deploying into the repository owner's Cloudflare account and then exercising the actual ChatGPT product UI against that deployed account.

## License

No license has been selected yet. Add one before accepting external contributions or redistributing builds outside the intended use.
