# ChatGPT Bridge for Windows

Windows-first bridge that exposes **live VS Code editor context** to ChatGPT through the Model Context Protocol (MCP).

> Status: early MVP. The first version is deliberately **read-only**. It does not edit files, run commands, or execute tests.

## Why this project exists

ChatGPT's macOS Work with Apps integration can receive context from supported local editors. On Windows, a custom ChatGPT MCP app cannot directly call `localhost`, so this project separates the problem into two local pieces:

```text
VS Code
  │  local WebSocket (loopback + shared secret)
  ▼
ChatGPT Bridge service
  ├─ live editor state
  ├─ safe workspace reads/search
  └─ MCP endpoint on 127.0.0.1
        │
        ▼
Secure MCP Tunnel / supported remote MCP path
        │
        ▼
ChatGPT custom MCP app
```

The VS Code extension provides editor-only information that a filesystem MCP cannot see, including unsaved buffers, the current selection, and VS Code diagnostics.

## MVP tools

The bridge exposes these read-only MCP tools:

- `get_workspace` — current VS Code workspace folders and connection state.
- `get_active_editor` — active file metadata and current editor buffer, including unsaved changes.
- `get_selection` — current selection and selected text.
- `get_diagnostics` — diagnostics currently reported by VS Code.
- `read_file` — safely read an existing file inside an open workspace.
- `search_workspace` — literal text search implemented without shell execution.

## Requirements

- Windows 10/11
- Node.js 20+
- VS Code
- A ChatGPT plan/workspace that supports the MCP app workflow you intend to use

ChatGPT does not connect directly to a local MCP server. OpenAI documents Secure MCP Tunnel for MCP servers running on a developer machine or private network:
https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt

## Development setup

```powershell
git clone https://github.com/ChathurangaBW/ChatGPT-Bridge-for-Windows.git
cd ChatGPT-Bridge-for-Windows
npm install
npm run typecheck
```

### 1. Start the local bridge

```powershell
npm run dev:bridge
```

Defaults:

- VS Code WebSocket: `ws://127.0.0.1:47321`
- MCP endpoint: `http://127.0.0.1:47322/mcp`
- Health endpoint: `http://127.0.0.1:47322/health`

The bridge creates a random local pairing secret at:

```text
%LOCALAPPDATA%\ChatGPTBridge\bridge-token
```

The VS Code extension reads the same file. The secret is never intentionally sent outside the machine.

Optional environment variables:

```text
BRIDGE_WS_PORT=47321
BRIDGE_MCP_PORT=47322
```

### 2. Build/run the VS Code extension

```powershell
npm run build:vscode
```

Open the `vscode-extension` folder in VS Code and press **F5** to launch an Extension Development Host. Start the bridge service first so the extension can read the pairing secret.

The status-bar item shows whether the extension is connected to the local bridge.

### 3. Test the MCP endpoint locally

The endpoint is Streamable HTTP. It is intentionally bound only to `127.0.0.1` and uses MCP host/origin validation on the local HTTP server.

For ChatGPT, connect the local endpoint using OpenAI's supported Secure MCP Tunnel flow rather than exposing the bridge directly to the public internet.

## Security model

Version 0.1 follows a least-privilege model:

- both local listeners bind to `127.0.0.1` only;
- VS Code ↔ bridge WebSocket requires a generated pairing secret;
- MCP tools are annotated read-only;
- `read_file` resolves real paths and rejects paths outside current workspace roots;
- workspace search skips symlinks, common generated/dependency directories, binary-looking files, and oversized files;
- no arbitrary shell/terminal tool exists;
- no write/edit tool exists.

See [SECURITY.md](SECURITY.md) before adding mutation or command-execution capabilities.

## Architecture

```text
vscode-extension/
  VS Code API -> EditorSnapshot -> authenticated localhost WebSocket

bridge/
  WebSocket server -> EditorStateStore
                            │
                            ├─ MCP editor tools
                            └─ safe filesystem/search tools
```

The MCP implementation uses the current v2 TypeScript SDK packages and Streamable HTTP. MCP SDK documentation:
https://ts.sdk.modelcontextprotocol.io/v2/

## Roadmap

1. Stabilize read-only editor context and MCP transport.
2. Add automated protocol/unit tests.
3. Add a Windows tray/companion process and installer.
4. Add opt-in, reviewable VS Code `WorkspaceEdit` operations.
5. Add narrowly allowlisted Git/test tools only after permission UX exists.

## License

No license has been selected yet. Add one before accepting external contributions or redistributing builds.
