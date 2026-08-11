export const BRIDGE_ORIGIN = "https://lucky-heart-f5b9.chatgpt-bridge.workers.dev";
export const BRIDGE_MCP_URL = `${BRIDGE_ORIGIN}/mcp`;

const REQUIRED_RUNTIME_CAPABILITIES = [
  "oauth-issuer",
  "mcp-routing-headers",
  "vsix-direct-relay",
] as const;

export type DiagnosticState = "pass" | "fail";

export interface BridgeDiagnosticCheck {
  id: "worker" | "oauth-resource" | "oauth-server" | "mcp-challenge";
  label: string;
  state: DiagnosticState;
  detail: string;
}

export interface BridgeDiagnostics {
  ok: boolean;
  checkedAt: number;
  checks: BridgeDiagnosticCheck[];
}

interface HealthPayload {
  ok?: unknown;
  service?: unknown;
  version?: unknown;
  capabilities?: unknown;
}

interface ProtectedResourcePayload {
  resource?: unknown;
  authorization_servers?: unknown;
  scopes_supported?: unknown;
}

interface AuthorizationServerPayload {
  issuer?: unknown;
  authorization_endpoint?: unknown;
  token_endpoint?: unknown;
  registration_endpoint?: unknown;
  scopes_supported?: unknown;
  grant_types_supported?: unknown;
  code_challenge_methods_supported?: unknown;
  token_endpoint_auth_methods_supported?: unknown;
}

function hasStrings(value: unknown, required: readonly string[]): boolean {
  if (!Array.isArray(value)) return false;
  const items = new Set(value.filter((item): item is string => typeof item === "string"));
  return required.every((item) => items.has(item));
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function pass(id: BridgeDiagnosticCheck["id"], label: string, detail: string): BridgeDiagnosticCheck {
  return { id, label, state: "pass", detail };
}

function fail(id: BridgeDiagnosticCheck["id"], label: string, detail: string): BridgeDiagnosticCheck {
  return { id, label, state: "fail", detail };
}

export async function runBridgeDiagnostics(
  fetchImpl: typeof fetch = fetch,
  origin = BRIDGE_ORIGIN,
): Promise<BridgeDiagnostics> {
  const checks: BridgeDiagnosticCheck[] = [];
  const mcpUrl = `${origin.replace(/\/+$/, "")}/mcp`;

  try {
    const response = await fetchImpl(`${origin}/health`, { signal: AbortSignal.timeout(8_000) });
    const body = (await safeJson(response)) as HealthPayload | null;
    const capabilities = body?.capabilities;
    if (
      response.ok &&
      body?.ok === true &&
      body.service === "chatgpt-bridge-cloud" &&
      hasStrings(capabilities, REQUIRED_RUNTIME_CAPABILITIES)
    ) {
      checks.push(pass("worker", "Hosted Worker", `Online — v${String(body.version ?? "unknown")}; current Bridge runtime detected.`));
    } else if (response.ok && body?.ok === true) {
      checks.push(fail("worker", "Hosted Worker", "Online, but it is an older Bridge runtime. Redeploy the current Worker before reauthenticating ChatGPT."));
    } else {
      checks.push(fail("worker", "Hosted Worker", `Health check failed with HTTP ${response.status}.`));
    }
  } catch (error) {
    checks.push(fail("worker", "Hosted Worker", error instanceof Error ? error.message : "Worker health check failed."));
  }

  try {
    const response = await fetchImpl(`${origin}/.well-known/oauth-protected-resource/mcp`, { signal: AbortSignal.timeout(8_000) });
    const body = (await safeJson(response)) as ProtectedResourcePayload | null;
    if (
      response.ok &&
      body?.resource === mcpUrl &&
      hasStrings(body.authorization_servers, [origin]) &&
      hasStrings(body.scopes_supported, ["bridge:read"])
    ) {
      checks.push(pass("oauth-resource", "OAuth protected resource", "Canonical /mcp resource metadata is ready."));
    } else {
      checks.push(fail("oauth-resource", "OAuth protected resource", "Protected-resource metadata does not match this Bridge endpoint."));
    }
  } catch (error) {
    checks.push(fail("oauth-resource", "OAuth protected resource", error instanceof Error ? error.message : "OAuth resource discovery failed."));
  }

  try {
    const response = await fetchImpl(`${origin}/.well-known/oauth-authorization-server`, { signal: AbortSignal.timeout(8_000) });
    const body = (await safeJson(response)) as AuthorizationServerPayload | null;
    if (
      response.ok &&
      body?.issuer === origin &&
      body.authorization_endpoint === `${origin}/authorize` &&
      body.token_endpoint === `${origin}/token` &&
      body.registration_endpoint === `${origin}/register` &&
      hasStrings(body.scopes_supported, ["bridge:read", "offline_access"]) &&
      hasStrings(body.grant_types_supported, ["authorization_code", "refresh_token"]) &&
      hasStrings(body.code_challenge_methods_supported, ["S256"]) &&
      hasStrings(body.token_endpoint_auth_methods_supported, ["none"])
    ) {
      checks.push(pass("oauth-server", "OAuth authorization server", "PKCE, refresh tokens, DCR, and offline access are advertised."));
    } else {
      checks.push(fail("oauth-server", "OAuth authorization server", "OAuth discovery is incomplete or does not match the Bridge origin."));
    }
  } catch (error) {
    checks.push(fail("oauth-server", "OAuth authorization server", error instanceof Error ? error.message : "OAuth server discovery failed."));
  }

  try {
    const response = await fetchImpl(mcpUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "bridge-doctor", method: "tools/list", params: {} }),
      signal: AbortSignal.timeout(8_000),
    });
    const challenge = response.headers.get("www-authenticate") ?? "";
    if (response.status === 401 && /resource_metadata=/i.test(challenge)) {
      checks.push(pass("mcp-challenge", "MCP OAuth challenge", "Unauthenticated /mcp correctly requests OAuth instead of exposing tools."));
    } else {
      checks.push(fail("mcp-challenge", "MCP OAuth challenge", `Expected OAuth HTTP 401 challenge; received HTTP ${response.status}.`));
    }
  } catch (error) {
    checks.push(fail("mcp-challenge", "MCP OAuth challenge", error instanceof Error ? error.message : "MCP challenge check failed."));
  }

  return {
    ok: checks.length === 4 && checks.every((check) => check.state === "pass"),
    checkedAt: Date.now(),
    checks,
  };
}
