# Security

This project bridges an AI-facing tool protocol to a developer workstation. Treat every new capability as privileged.

## Current v0.2 boundary

Version 0.2 is read-only. It exposes editor context, diagnostics, safe file reads, and literal workspace search. It intentionally does **not** expose:

- arbitrary command execution or terminal access;
- file creation/modification/deletion;
- Git mutation;
- test/build execution;
- access outside currently open VS Code workspace roots.

## Local transport

The VS Code WebSocket and MCP HTTP listeners bind only to `127.0.0.1`.

VS Code authenticates with a random per-user secret stored under `%LOCALAPPDATA%\ChatGPTBridge\bridge-token`. The bridge rejects unauthenticated clients, malformed/oversized snapshots, non-loopback HTTP Host/Origin values, and oversized MCP bodies.

Listener startup is fail-fast. Invalid, identical, or occupied listener ports terminate the bridge rather than leaving a partially running process.

Loopback binding and the local pairing secret do **not** protect against malicious software already running as the same Windows user. Treat that Windows user account as part of the trusted computing base.

## Editor and filesystem privacy

Editor state is bounded in the VS Code extension and revalidated at the MCP boundary:

- each authenticated VS Code window has an isolated snapshot;
- stale snapshots are removed on protocol violations/disconnects;
- active editor and selection data is withheld unless the active path resolves canonically inside a current workspace root;
- file reads resolve canonical real paths and reject workspace escapes/symlink traversal;
- ambiguous relative paths in multi-root workspaces are rejected;
- reads/search accept bounded UTF-8 text only and reject/skip binary-looking, invalid UTF-8, oversized, generated/dependency, and symlinked entries;
- workspace search has file-count and result caps.

## Cloud relay boundary

The public Worker is the only internet-facing component. The local MCP server is never bound publicly.

### Device identity

- A new Windows agent receives a random device ID and high-entropy device secret from the Worker.
- Only a SHA-256 hash of the device secret is persisted by the control plane.
- The Windows agent stores the device credential under the current user's `%LOCALAPPDATA%\ChatGPTBridge` directory.
- Device registration is rate-limited.
- The device connects outbound over authenticated WSS; no inbound Windows firewall/router rule is required.
- Each device is mapped to a separate Durable Object relay.
- A newer device WebSocket replaces the previous socket for that device.

### Pairing and OAuth

- Pairing codes are random, unambiguous 12-symbol capabilities with short expiry.
- Rotating a pairing code increments a device pairing generation.
- OAuth authorization codes capture that generation and are rejected at token exchange if a newer pairing attempt replaced them.
- OAuth authorization uses authorization-code + PKCE S256.
- Authorization codes are short-lived and single-use.
- PKCE comparisons use constant-time text comparison after hashing.
- Access tokens are scoped to the exact `/mcp` resource and `bridge:read` scope.
- Refresh tokens rotate on use and requested refresh scopes may only narrow, never broaden, the original grant.
- OAuth dynamic client registration is rate-limited and validates redirect URI scheme/credentials/fragments.
- OAuth/form/registration request bodies are explicitly bounded.

### MCP relay

- `/mcp` requires a valid bearer token for the exact public MCP resource.
- The Worker forwards only allowlisted MCP request headers.
- The Windows agent independently allowlists cloud-provided request headers before sending to localhost.
- Request and response bodies are size-bounded on both cloud and Windows sides.
- The local MCP handler uses JSON response mode; the relay does not expose arbitrary open-ended local HTTP proxying.
- Relay requests have finite timeouts and are rejected if the paired Windows agent is offline.
- The cloud protocol carries only MCP request/response envelopes; it does not provide a generic remote shell or arbitrary URL fetch capability.

## Dependency and CI policy

The permanent Windows CI gate uses:

- committed npm lockfile;
- `npm ci`;
- read-only repository token permissions;
- blocking `npm audit --audit-level=moderate`;
- TypeScript checks/builds;
- behavioral unit tests;
- Cloudflare Worker dry-run packaging;
- a real local `workerd` OAuth/device/MCP relay smoke test;
- VSIX and standalone EXE packaging;
- packaged EXE health, occupied-port, and malformed-config smoke checks.

Do not waive moderate-or-higher dependency findings without a documented reason and compensating controls.

## Cloudflare account boundary

Deploying the Worker requires authorization to the repository owner's Cloudflare account. Those Cloudflare credentials are an operator/deployment concern and are not embedded in the Windows executable, VSIX, repository, OAuth tokens, or device credential.

The deployed public endpoint must remain HTTPS and must not bypass the OAuth/device controls implemented here.

## Future write tools

Any future write/edit capability should be implemented through VS Code `WorkspaceEdit` (or an equivalent VS Code API) with explicit user review and normal undo behavior.

Any future command/test capability must use a narrow allowlist with structured arguments. Do not add a generic `run_command(command: string)` tool.

## Reporting

Until a private vulnerability-reporting channel is configured, do not publish exploit details in a public issue. Contact the repository owner privately through an appropriate GitHub channel.
