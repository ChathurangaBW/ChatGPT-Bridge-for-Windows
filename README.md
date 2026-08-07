# ChatGPT Bridge for Windows

Windows-first bridge that exposes **live VS Code editor context** to normal ChatGPT conversations through the Model Context Protocol (MCP), without using Codex as the user-facing workflow.

> **v0.1 is deliberately read-only.** It can expose editor/workspace context, diagnostics, safe file reads, and literal workspace search. It cannot edit files, execute commands, mutate Git, or run tests on behalf of ChatGPT.

## Architecture

```text
VS Code
  │  authenticated loopback WebSocket
  │  active file / unsaved buffer / selection / diagnostics
  ▼
ChatGPTBridge.exe
  ├─ editor state
  ├─ safe workspace reads/search
  └─ Streamable HTTP MCP: http://127.0.0.1:47322/mcp
        │
        ▼
OpenAI Secure MCP Tunnel
        │ outbound HTTPS
        ▼
ChatGPT custom MCP app
```

The VS Code extension provides editor-only state that a filesystem-only MCP server cannot see, including unsaved buffers, the current selection, and VS Code diagnostics.

## MCP tools

The bridge exposes six read-only tools:

- `get_workspace` — current VS Code workspace folders and connection state.
- `get_active_editor` — active file metadata and current editor buffer, including unsaved changes.
- `get_selection` — current selection and selected text.
- `get_diagnostics` — diagnostics currently reported by VS Code for open workspace files.
- `read_file` — safely read an existing text file inside an open workspace root.
- `search_workspace` — bounded literal text search without shell execution.

## Install the packaged Windows build

A successful CI run produces the artifact **`chatgpt-bridge-windows-0.1.0`** containing:

```text
ChatGPTBridge.exe
chatgpt-bridge-vscode-0.1.0.vsix
```

`ChatGPTBridge.exe` contains its Node runtime, so Node.js is not required merely to run the packaged bridge. The current development build is not code-signed, so Windows may display normal warnings for an unsigned downloaded executable. Verify that the binary came from this repository's successful GitHub Actions run before launching it.

### 1. Start the bridge

Run:

```powershell
.\ChatGPTBridge.exe
```

Defaults:

- VS Code WebSocket: `ws://127.0.0.1:47321`
- MCP endpoint: `http://127.0.0.1:47322/mcp`
- Health endpoint: `http://127.0.0.1:47322/health`

The bridge creates a random local pairing secret at:

```text
%LOCALAPPDATA%\ChatGPTBridge\bridge-token
```

Optional environment variables:

```text
BRIDGE_WS_PORT=47321
BRIDGE_MCP_PORT=47322
```

The two ports must be different. If `BRIDGE_WS_PORT` is changed, set the VS Code setting `chatgptBridge.wsPort` to the same number and reload the extension.

### 2. Install the VS Code extension

In VS Code use **Extensions → … → Install from VSIX…** and choose:

```text
chatgpt-bridge-vscode-0.1.0.vsix
```

Or, if the `code` CLI is available:

```powershell
code --install-extension .\chatgpt-bridge-vscode-0.1.0.vsix
```

The status bar shows **ChatGPT Bridge** when connected. Run **ChatGPT Bridge: Show Status** from the Command Palette to inspect the current connection state and endpoint.

### 3. Verify the local bridge

```powershell
Invoke-RestMethod http://127.0.0.1:47322/health
```

With VS Code connected, `vscodeConnected` should be `true`.

## Connect the local MCP server to ChatGPT

ChatGPT does not directly reach a private/localhost MCP server through the cloud. OpenAI provides **Secure MCP Tunnel** for this case.

Official resources:

- https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt
- https://github.com/openai/tunnel-client
- https://developers.openai.com/api/docs/guides/secure-mcp-tunnels

Create/obtain a tunnel ID and runtime API key using OpenAI's supported tunnel setup, then configure the tunnel client to forward to this bridge:

```powershell
$env:CONTROL_PLANE_API_KEY="sk-..."
$env:CONTROL_PLANE_TUNNEL_ID="tunnel_0123456789abcdef0123456789abcdef"
$env:MCP_SERVER_URL="http://127.0.0.1:47322/mcp"

tunnel-client run --log.level=info --log.format=struct-text
```

The official tunnel client keeps the MCP server private and forwards requests from OpenAI products to the configured local Streamable HTTP endpoint over an outbound HTTPS tunnel. Keep the tunnel client running while ChatGPT needs the connector.

Then attach the provisioned tunnel in the supported ChatGPT connector/app settings for your organization and scan the MCP tools.

## Development from source

### Requirements

- Windows 10/11 for the release/smoke target
- Node.js 22+ for the complete development and packaging toolchain
- npm
- VS Code

Clone and verify:

```powershell
git clone https://github.com/ChathurangaBW/ChatGPT-Bridge-for-Windows.git
cd ChatGPT-Bridge-for-Windows
npm ci
npm run qa
```

Run the development bridge:

```powershell
npm run dev:bridge
```

Build the VS Code extension and use **F5** from the `vscode-extension` folder to launch an Extension Development Host.

### Build distributables

```powershell
npm run package:release
```

This produces:

```text
artifacts\ChatGPTBridge.exe
artifacts\chatgpt-bridge-vscode-0.1.0.vsix
```

Packaging tools are version-pinned in the npm scripts. CI runs on Windows, audits dependencies, executes behavioral tests, builds the TypeScript projects, packages both artifacts, launches the packaged EXE, and probes its health endpoint.

## Security model

Version 0.1 follows a least-privilege design:

- both local listeners bind only to `127.0.0.1`;
- VS Code ↔ bridge WebSocket requires a generated pairing secret;
- inbound editor snapshots are schema-validated and size-bounded;
- MCP Host/Origin values and request-body size are validated at the local HTTP boundary;
- editor-dependent MCP calls fail when VS Code disconnects instead of returning stale editor state;
- `read_file` resolves canonical paths and rejects paths outside current workspace roots;
- ambiguous relative paths in multi-root workspaces are rejected;
- workspace search skips symlinks, common generated/dependency directories, binary-looking files, and oversized files;
- no arbitrary shell/terminal tool exists;
- no write/edit tool exists.

See [SECURITY.md](SECURITY.md) for the threat boundary and rules for future mutating tools.

## Repository layout

```text
bridge/
  src/                 local bridge, MCP server, security boundary
  test/                state/filesystem/WebSocket/MCP integration tests

vscode-extension/
  src/                 live VS Code context publisher

.github/workflows/
  ci.yml               Windows QA, audit, package, executable smoke test
```

## Current release QA

The automated suite covers:

- authenticated and rejected VS Code WebSocket pairing;
- schema validation of live editor snapshots;
- editor state connection/disconnection lifecycle;
- workspace canonical-path containment and multi-root ambiguity;
- binary and oversized-file rejection;
- bounded workspace search;
- MCP health endpoint;
- MCP initialize/tool discovery/tool call flow;
- hostile Host rejection;
- TypeScript typechecking/build;
- dependency audit;
- VSIX packaging;
- packaged Windows EXE startup/health smoke test.

A CI pass validates the repository-controlled portions of the application. The final ChatGPT ↔ Secure MCP Tunnel connection still depends on the user's OpenAI organization, tunnel permissions/API key, and ChatGPT plan/workspace configuration and therefore is not exercised with repository secrets in public CI.

## Roadmap after v0.1

1. Windows code signing and a conventional installer/tray experience.
2. Opt-in, reviewable VS Code `WorkspaceEdit` operations.
3. Narrowly allowlisted Git/test tools with explicit permission UX.
4. Additional telemetry-free local diagnostics and connection troubleshooting.

## License

No license has been selected yet. Add one before accepting external contributions or redistributing builds outside your intended use.
