# ChatGPT Bridge for Windows — VS Code Extension

ChatGPT Bridge now runs entirely inside VS Code. The **VSIX is the only end-user package**; there is no companion EXE, localhost MCP server, local WebSocket port, ngrok tunnel, or OpenAI API key.

The extension opens an outbound authenticated WebSocket to the hosted ChatGPT Bridge relay and handles MCP requests directly inside the currently focused VS Code window.

## Read-only tools

The extension exposes six MCP tools through the relay:

- `get_workspace`
- `get_active_editor`
- `get_selection`
- `get_diagnostics`
- `read_file`
- `search_workspace`

Editor/file data is read only when ChatGPT invokes a tool. The extension does not continuously upload the editor buffer.

Workspace privacy checks are enforced inside the extension. Canonical real paths are used so files outside the currently open workspace, including symlink escapes, are withheld. Reads are limited to bounded UTF-8 text files; search is literal, bounded, and skips common generated/dependency directories.

The extension does not edit files, save files, execute shell commands, run tests, or mutate Git.

## Pairing and credentials

On first activation the extension registers a device with the hosted relay and displays a short pairing code in the ChatGPT Bridge status item. When ChatGPT opens the OAuth authorization page, enter that pairing code.

The long-lived device secret is stored in VS Code `SecretStorage`. Device metadata is stored in VS Code global extension state. If the previous EXE-based v0.2 bridge credential is present, the extension imports it once so an existing ChatGPT authorization can continue without the EXE.

Multiple VS Code windows may use the same paired device. The relay routes MCP calls to the most recently focused VS Code window.

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

Install it with **VS Code → Extensions → … → Install from VSIX…**, then reload VS Code.

Use **ChatGPT Bridge: Show Status** from the Command Palette to see relay/pairing state. You can also use **ChatGPT Bridge: Copy Pairing Code** and **ChatGPT Bridge: Open Pairing Page**.
