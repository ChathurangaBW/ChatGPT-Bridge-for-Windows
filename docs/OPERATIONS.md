# ChatGPT Bridge operations

This runbook is for the **operator/developer of ChatGPT Bridge**, not for end users installing the VSIX.

End users do not configure Cloudflare credentials, OpenAI API keys, tunnel IDs, localhost URLs, or router/firewall rules.

## Product flow

```text
Operator deploys hosted Worker
          ↓
User installs ChatGPT Bridge VSIX
          ↓
VS Code opens ChatGPT Bridge setup
          ↓
Extension connects outbound to Worker
          ↓
User connects ChatGPT Bridge in ChatGPT Plugins
          ↓
OAuth page asks for VS Code pairing code
          ↓
ChatGPT is authorized for that VS Code device
          ↓
get_workspace can render the inline workspace status card
```

## Hosted endpoints

Current development Worker:

```text
https://lucky-heart-f5b9.chatgpt-bridge.workers.dev
```

MCP endpoint:

```text
https://lucky-heart-f5b9.chatgpt-bridge.workers.dev/mcp
```

The Worker also serves:

- `/` — product/setup landing page
- `/health` — deployment health check
- `/authorize` — OAuth authorization UI
- `/pair/<code>` — pairing helper page
- `/mcp` — OAuth-protected MCP endpoint
- `/device/*` — VS Code extension device connection routes

## One-time GitHub environment setup

Create a GitHub Actions environment named:

```text
bridge-development
```

Add these **operator-only environment secrets**:

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
```

Optionally add this environment variable:

```text
BRIDGE_PUBLIC_URL=https://lucky-heart-f5b9.chatgpt-bridge.workers.dev
```

The Worker deployment workflow reads those values only inside GitHub Actions. They are never bundled in the VSIX.

When a real production environment is needed later, create:

```text
bridge-production
```

with its own Cloudflare credentials/variables. The workflow refuses a production deployment from a branch other than `main`.

## Deploy development Worker

1. Open the repository on GitHub.
2. Open **Actions → Deploy ChatGPT Bridge Worker**.
3. Choose **Run workflow**.
4. Select the branch you want to test.
5. Choose target **development**.
6. Run the workflow.

The workflow performs:

```text
npm ci
npm run qa
wrangler deploy
GET /health polling
hosted landing-page smoke
live OAuth + device + MCP runtime smoke
live authorization-UI smoke
```

A successful run means the deployed Worker is the same functional build that passed repository QA. This is the normal way to avoid the stale-Worker mismatch that can otherwise occur when source changes are not redeployed.

## Connect the development plugin in ChatGPT

Use ChatGPT Developer Mode while the project is still under development.

1. In ChatGPT, enable **Developer mode** under **Settings → Security and login**.
2. Open the **ChatGPT Plugins** page.
3. Choose the **+** action to add a plugin.
4. Use:

   ```text
   Name: ChatGPT Bridge
   Description: Read the VS Code workspace currently connected through ChatGPT Bridge.
   MCP URL: https://lucky-heart-f5b9.chatgpt-bridge.workers.dev/mcp
   ```

5. Create/connect the plugin.
6. In VS Code, open **ChatGPT Bridge: Open Setup**.
7. Copy the pairing code displayed in the setup panel.
8. When the Bridge OAuth page opens from ChatGPT, enter the pairing code and authorize the VS Code device.
9. Start a normal ChatGPT conversation, enable ChatGPT Bridge for the conversation, and ask for the current workspace.

No OpenAI API key is part of this flow.

## Refresh after MCP or UI changes

ChatGPT caches tool and UI metadata. After changing any of these:

- tool names/descriptions/schemas
- tool `_meta`
- MCP UI resource URI/content
- OAuth metadata
- Worker MCP protocol behavior

perform this sequence:

1. Deploy the Worker with **Deploy ChatGPT Bridge Worker**.
2. Confirm its post-deploy smoke is green.
3. Open the ChatGPT Bridge plugin entry in ChatGPT.
4. Select **Refresh**.
5. Re-run `get_workspace` in a new conversation or after re-enabling the plugin.

The `get_workspace` result should display the inline **ChatGPT Bridge — Live VS Code workspace** card with the active file, workspace folders, and **Refresh from VS Code** action.

## VS Code end-user experience

First activation automatically opens the **ChatGPT Bridge** setup panel once.

The panel shows:

- relay connection state
- pairing state
- current pairing code when needed
- **Copy pairing code**
- **Open pairing page**
- **Open ChatGPT**
- **Retry connection** when disconnected

The status bar remains available after the first run. Clicking it reopens setup.

Useful commands:

```text
ChatGPT Bridge: Open Setup
ChatGPT Bridge: Show Status
ChatGPT Bridge: Copy Pairing Code
ChatGPT Bridge: Open Pairing Page
```

## Development validation without deploying

From the repository root:

```powershell
npm ci
npm run qa
```

For the complete local Worker runtime smoke:

```powershell
npm run dev --workspace cloud-worker -- --port 8787
```

In a second terminal:

```powershell
npm run smoke --workspace cloud-worker
```

The smoke suite covers the OAuth/device/MCP relay plus the hosted product, pairing, and authorization pages.

## Release candidate checklist

Before handing a VSIX to testers:

1. `main` or the candidate branch is green in CI.
2. The development Worker deployment workflow is green for the exact candidate commit.
3. ChatGPT Bridge has been refreshed in ChatGPT after that deployment.
4. VS Code setup shows **Connected to ChatGPT** after pairing.
5. `get_workspace` renders the inline workspace card.
6. `get_active_editor`, `get_selection`, `get_diagnostics`, `read_file`, and `search_workspace` work in the same conversation.
7. Restart VS Code once and confirm it reconnects without pairing again.

Only after this development loop is stable should the same workflow be pointed at `bridge-production` from `main`.
