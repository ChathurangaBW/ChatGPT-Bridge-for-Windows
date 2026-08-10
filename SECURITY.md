# Security

This project bridges an AI-facing tool protocol to a developer workstation. Treat every new capability as privileged.

## Current v0.2 boundary

Version 0.2 is read-only. It exposes editor context, diagnostics, safe file reads, and literal workspace search. It intentionally does **not** expose:

- arbitrary command execution or terminal access;
- file creation/modification/deletion;
- Git mutation;
- test/build execution;
- access outside currently open VS Code workspace roots.

## End-user client

The VSIX is the complete end-user client. There is no companion executable, localhost WebSocket, localhost MCP HTTP server, or user-configurable local port.

The extension connects outbound to the hosted relay over authenticated WSS. The device secret is stored with VS Code `SecretStorage`, which is the VS Code API intended for encrypted sensitive extension state. Non-secret device metadata is stored in extension global state.

For upgrades from the prior EXE-based v0.2 design, the extension may import the existing cloud device credential once from `%LOCALAPPDATA%\ChatGPTBridge\cloud-device.json`. The legacy file is not required for new installations and the EXE is not used after migration.

## Editor and filesystem privacy

Workspace data is gathered on demand when an MCP tool is invoked; the extension does not continuously publish editor snapshots.

- active editor and selection data is withheld unless the active path resolves canonically inside a current workspace root;
- file reads resolve canonical real paths and reject workspace escapes/symlink traversal;
- ambiguous relative paths in multi-root workspaces are rejected;
- reads require bounded valid UTF-8 text and reject binary-looking or oversized files;
- workspace search is literal and has file/result caps;
- search skips common dependency/generated directories;
- diagnostics are filtered to canonical paths inside the open workspace.

## Cloud relay boundary

The public Worker is the only internet-facing component.

### Device identity

- A new VS Code installation receives a random device ID and high-entropy device secret from the Worker.
- Only a SHA-256 hash of the device secret is persisted by the control plane.
- The device secret is stored through VS Code `SecretStorage`.
- Device registration is rate-limited.
- VS Code connects outbound over authenticated WSS; no inbound Windows firewall/router rule is required.
- Each device is mapped to a separate Durable Object relay.
- Multiple VS Code windows may connect for one paired device, with a strict socket cap.
- Focus signals select the most recently focused VS Code window for new MCP calls.
- In-flight MCP calls are bound to the exact socket that received them so another/stale window cannot satisfy them.

### Pairing and OAuth

- Pairing codes are random, unambiguous 12-symbol capabilities with short expiry.
- Rotating a pairing code increments a device pairing generation.
- OAuth authorization codes capture that generation and are rejected at token exchange if a newer pairing attempt replaced them.
- OAuth authorization uses authorization-code + PKCE S256.
- Authorization codes are short-lived and atomically single-use.
- Access tokens are scoped to the exact `/mcp` resource and `bridge:read` scope.
- Refresh tokens rotate atomically on use and cannot broaden the originally granted scope.
- OAuth registration validates redirect URI constraints and is rate-limited.
- OAuth/form/registration request bodies are explicitly bounded.

### MCP relay

- `/mcp` requires a valid bearer token for the exact public MCP resource.
- MCP 2026 routing headers are validated/synthesized at the gateway and rechecked inside the VS Code client.
- Request and response bodies and forwarded headers are bounded.
- The cloud protocol carries only MCP request/response and focus envelopes; it does not provide a generic remote shell or arbitrary URL fetch capability.
- Relay requests have finite timeouts and are rejected if no paired VS Code window is online.
- The six exposed MCP tools are read-only and execute inside the selected VS Code extension host.

## Dependency and CI policy

The permanent Windows CI gate uses:

- committed npm lockfile;
- `npm ci`;
- read-only repository token permissions;
- blocking `npm audit --audit-level=moderate`;
- TypeScript checks/builds;
- behavioral unit tests;
- Cloudflare Worker dry-run packaging;
- real local `workerd` OAuth/device/MCP relay smoke tests;
- focused multi-window relay routing smoke;
- VSIX packaging;
- packaged VSIX inspection that fails if an EXE or removed localhost bridge endpoint is present;
- a release artifact containing only the VSIX.

Do not waive moderate-or-higher dependency findings without a documented reason and compensating controls.

## Cloudflare account boundary

Deploying the Worker requires authorization to the repository owner's Cloudflare account. Those Cloudflare credentials are an operator/deployment concern and are not embedded in the VSIX, OAuth tokens, or device credential.

The deployed public endpoint must remain HTTPS and must not bypass the OAuth/device controls implemented here.

## Future write tools

Any future write/edit capability should be implemented through VS Code `WorkspaceEdit` (or an equivalent VS Code API) with explicit user review and normal undo behavior.

Any future command/test capability must use a narrow allowlist with structured arguments. Do not add a generic `run_command(command: string)` tool.

## Reporting

Until a private vulnerability-reporting channel is configured, do not publish exploit details in a public issue. Contact the repository owner privately through an appropriate GitHub channel.
