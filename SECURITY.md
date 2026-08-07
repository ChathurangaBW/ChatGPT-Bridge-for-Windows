# Security

This project bridges an AI-facing tool protocol to a developer workstation. Treat every new capability as privileged.

## Current MVP boundary

The MVP is read-only. It exposes editor context, diagnostics, safe file reads, and literal workspace search. It intentionally does **not** expose:

- arbitrary command execution;
- terminal access;
- file creation/modification/deletion;
- Git mutation;
- test/build execution;
- access outside currently open VS Code workspace roots.

## Local transport

The WebSocket and MCP listeners bind to `127.0.0.1`. VS Code must authenticate to the WebSocket with the random token stored under `%LOCALAPPDATA%\ChatGPTBridge\bridge-token`.

The MCP HTTP listener uses the MCP SDK localhost Host and Origin validation guards. Do not change it to `0.0.0.0` merely to make ChatGPT connectivity easier. Use an authenticated/supported tunnel instead.

## Filesystem containment

File reads use canonical real paths. A target must resolve under one of the real workspace roots. Symlink traversal outside a workspace is rejected.

Workspace search does not follow symlinked directories/files and skips common dependency/build directories.

## Future write tools

Any future write/edit capability should be implemented through the VS Code API (for example `WorkspaceEdit`) rather than silent direct filesystem replacement. It should support explicit user review and preserve normal VS Code undo behavior.

Any future command/test capability should use a narrow allowlist with structured arguments. Do not add a generic `run_command(command: string)` tool.

## Reporting

Until a private vulnerability-reporting channel is configured, do not publish exploit details in a public issue. Contact the repository owner privately through an appropriate GitHub channel.
