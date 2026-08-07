# Security

This project bridges an AI-facing tool protocol to a developer workstation. Treat every new capability as privileged.

## Current v0.1 boundary

Version 0.1 is read-only. It exposes editor context, diagnostics, safe file reads, and literal workspace search. It intentionally does **not** expose:

- arbitrary command execution;
- terminal access;
- file creation/modification/deletion;
- Git mutation;
- test/build execution;
- access outside currently open VS Code workspace roots.

## Local transport

The WebSocket and MCP listeners bind only to `127.0.0.1`.

VS Code must authenticate to the WebSocket with a random token stored under `%LOCALAPPDATA%\ChatGPTBridge\bridge-token`. The Bridge rejects unauthenticated clients, malformed snapshots, oversized WebSocket payloads, non-loopback HTTP Host/Origin values, and oversized MCP request bodies.

The MCP HTTP listener uses a small in-repository Node/Web adapter with explicit loopback Host/Origin validation. Do not change the listener to `0.0.0.0` merely to make ChatGPT connectivity easier. Use OpenAI's supported Secure MCP Tunnel or another supported authenticated MCP path.

Listener startup is fail-fast. Invalid port configuration, identical WebSocket/MCP ports, or an occupied listener port terminates the bridge instead of leaving a partially running service.

### Local-machine trust boundary

Loopback binding and the pairing token protect against unintended network/browser access; they do **not** create a security boundary against malicious software already running as the same Windows user. A same-user process may be able to read the pairing-token file, inspect local files, or interact with local processes. Treat the Windows user account as part of the trusted computing base.

## Editor-data minimization

Published editor state is bounded before it leaves VS Code and re-validated before it leaves the bridge over MCP:

- active editor buffers are capped by UTF-8 byte size;
- selections are capped separately;
- diagnostic count and diagnostic field sizes are capped;
- only file diagnostics under currently open workspace folders are published by the extension;
- each authenticated VS Code window has an isolated snapshot session;
- if the most-recent window disconnects, the bridge falls back only to a snapshot owned by another still-connected window;
- active-editor and selection data are withheld unless the active file resolves canonically inside a current workspace root;
- editor-dependent MCP calls fail after all VS Code windows disconnect rather than returning stale editor state.

The MCP-layer canonical check is intentional defense in depth: extension-side filtering alone is not treated as the final privacy boundary.

## Filesystem containment

File reads use canonical real paths. A target must resolve under one of the real workspace roots. Symlink traversal outside a workspace is rejected.

For multi-root workspaces, relative paths that resolve to more than one root are rejected as ambiguous; callers must use an absolute path inside an allowed workspace root.

Workspace reads/search are bounded to UTF-8 text. NUL-containing/binary-looking data, invalid UTF-8, oversized files, symlinked entries, and common dependency/build directories are skipped or rejected. Search also has a maximum scanned-file count and result cap.

## Dependency and CI policy

The Windows CI gate uses the committed npm lockfile for deterministic repository installs and runs typechecking, behavioral tests, production builds, dependency audit, release packaging, and packaged-bridge smoke testing.

The packaged executable smoke test verifies normal health startup, failure on occupied default ports, failure on malformed port configuration, and that the original healthy bridge remains available after a collision attempt.

Do not waive moderate-or-higher dependency audit findings without documenting the rationale and compensating controls.

## Future write tools

Any future write/edit capability should be implemented through the VS Code API (for example `WorkspaceEdit`) rather than silent direct filesystem replacement. It should support explicit user review and preserve normal VS Code undo behavior.

Any future command/test capability should use a narrow allowlist with structured arguments. Do not add a generic `run_command(command: string)` tool.

## Reporting

Until a private vulnerability-reporting channel is configured, do not publish exploit details in a public issue. Contact the repository owner privately through an appropriate GitHub channel.
