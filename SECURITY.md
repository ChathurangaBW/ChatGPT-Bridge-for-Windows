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

### Local-machine trust boundary

Loopback binding and the pairing token protect against unintended network/browser access; they do **not** create a security boundary against malicious software already running as the same Windows user. A same-user process may be able to read the pairing-token file, inspect local files, or interact with local processes. Treat the Windows user account as part of the trusted computing base.

## Editor-data minimization

Published editor state is bounded before it leaves VS Code:

- active editor buffers are capped by UTF-8 byte size;
- selections are capped separately;
- diagnostic count and diagnostic field sizes are capped;
- only file diagnostics under currently open workspace folders are published;
- editor-dependent MCP calls fail after VS Code disconnects rather than returning stale editor state.

## Filesystem containment

File reads use canonical real paths. A target must resolve under one of the real workspace roots. Symlink traversal outside a workspace is rejected.

For multi-root workspaces, relative paths that resolve to more than one root are rejected as ambiguous; callers must use an absolute path inside an allowed workspace root.

Workspace search does not follow symlinked directories/files, rejects access outside canonical workspace roots, and skips common dependency/build directories, binary-looking files, and oversized files.

## Dependency and CI policy

The Windows CI gate runs typechecking, behavioral tests, production builds, dependency audit, release packaging, and packaged-bridge smoke testing. The repository lockfile is used for deterministic CI installs once generated/committed.

Do not waive moderate-or-higher dependency audit findings without documenting the rationale and compensating controls.

## Future write tools

Any future write/edit capability should be implemented through the VS Code API (for example `WorkspaceEdit`) rather than silent direct filesystem replacement. It should support explicit user review and preserve normal VS Code undo behavior.

Any future command/test capability should use a narrow allowlist with structured arguments. Do not add a generic `run_command(command: string)` tool.

## Reporting

Until a private vulnerability-reporting channel is configured, do not publish exploit details in a public issue. Contact the repository owner privately through an appropriate GitHub channel.
