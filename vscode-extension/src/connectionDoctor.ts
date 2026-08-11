import { createHash, randomBytes } from "node:crypto";

export const BRIDGE_ORIGIN = "https://lucky-heart-f5b9.chatgpt-bridge.workers.dev";
export const BRIDGE_MCP_URL = `${BRIDGE_ORIGIN}/mcp`;

export type DiagnosticState = "pass" | "fail";

export interface BridgeDiagnosticCheck {
  id: "worker" | "oauth-resource" | "oauth-server" | "oauth-redirect" | "mcp-challenge";
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

interface ClientRegistrationPayload {
  client_id?: unknown;
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

function b64url(value: Buffer): string {
  return value.toString("base64url");
}

export async function runBridgeDiagnostics(
  fetchImpl: typeof fetch = fetch,
  origin = BRIDGE_ORIGIN,
  pairingCode?: string,
): Promise<BridgeDiagnostics> {
  const checks: BridgeDiagnosticCheck[] = [];
  const normalizedOrigin = origin.replace(/\/+$/, "");
  const mcpUrl = `${normalizedOrigin}/mcp`;

  try {
    const response = await fetchImpl(`${normalizedOrigin}/health`, { signal: AbortSignal.timeout(8_000) });
    const body = (await safeJson(response)) as HealthPayload | null;
    if (response.ok && body?.ok === true && body.service === "chatgpt-bridge-cloud") {
      checks.push(pass("worker", "Hosted Worker", `Online — v${String(body.version ?? "unknown")}.`));
    } else {
      checks.push(fail("worker", "Hosted Worker", `Health check failed with HTTP ${response.status}.`));
    }
  } catch (error) {
    checks.push(fail("worker", "Hosted Worker", error instanceof Error ? error.message : "Worker health check failed."));
  }

  try {
    const response = await fetchImpl(`${normalizedOrigin}/.well-known/oauth-protected-resource/mcp`, { signal: AbortSignal.timeout(8_000) });
    const body = (await safeJson(response)) as ProtectedResourcePayload | null;
    if (
      response.ok &&
      body?.resource === mcpUrl &&
      hasStrings(body.authorization_servers, [normalizedOrigin]) &&
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
    const response = await fetchImpl(`${normalizedOrigin}/.well-known/oauth-authorization-server`, { signal: AbortSignal.timeout(8_000) });
    const body = (await safeJson(response)) as AuthorizationServerPayload | null;
    if (
      response.ok &&
      body?.issuer === normalizedOrigin &&
      body.authorization_endpoint === `${normalizedOrigin}/authorize` &&
      body.token_endpoint === `${normalizedOrigin}/token` &&
      body.registration_endpoint === `${normalizedOrigin}/register` &&
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

  if (!pairingCode) {
    checks.push(fail("oauth-redirect", "OAuth authorization redirect", "No active VS Code pairing code is available yet. Connect the relay first, then run the check again."));
  } else {
    try {
      const redirectUri = "http://127.0.0.1:8792/callback";
      const registration = await fetchImpl(`${normalizedOrigin}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "ChatGPT Bridge VSIX connection doctor",
          application_type: "native",
          redirect_uris: [redirectUri],
          token_endpoint_auth_method: "none",
        }),
        signal: AbortSignal.timeout(8_000),
      });
      const registered = (await safeJson(registration)) as ClientRegistrationPayload | null;
      if (!registration.ok || typeof registered?.client_id !== "string") {
        checks.push(fail("oauth-redirect", "OAuth authorization redirect", `Dynamic client registration failed with HTTP ${registration.status}.`));
      } else {
        const verifier = b64url(randomBytes(48));
        const challenge = b64url(createHash("sha256").update(verifier).digest());
        const state = b64url(randomBytes(18));
        const authorize = new URLSearchParams({
          response_type: "code",
          client_id: registered.client_id,
          redirect_uri: redirectUri,
          code_challenge: challenge,
          code_challenge_method: "S256",
          scope: "bridge:read offline_access",
          state,
          resource: mcpUrl,
          pairing_code: pairingCode,
        });
        const response = await fetchImpl(`${normalizedOrigin}/authorize`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: authorize,
          redirect: "manual",
          signal: AbortSignal.timeout(8_000),
        });
        const location = response.headers.get("location");
        if (response.status !== 302 || !location) {
          checks.push(fail("oauth-redirect", "OAuth authorization redirect", `Authorization self-check did not redirect (HTTP ${response.status}). The pairing code may have expired.`));
        } else {
          const callback = new URL(location);
          if (callback.searchParams.get("iss") !== normalizedOrigin) {
            checks.push(fail("oauth-redirect", "OAuth authorization redirect", "Worker update required: the OAuth callback is missing the current issuer marker used by ChatGPT reauthentication."));
          } else if (callback.searchParams.get("state") !== state || !callback.searchParams.get("code")) {
            checks.push(fail("oauth-redirect", "OAuth authorization redirect", "OAuth callback did not preserve state or return an authorization code."));
          } else {
            checks.push(pass("oauth-redirect", "OAuth authorization redirect", "OAuth callback issuer/state behavior matches the current ChatGPT Bridge runtime."));
          }
        }
      }
    } catch (error) {
      checks.push(fail("oauth-redirect", "OAuth authorization redirect", error instanceof Error ? error.message : "OAuth authorization self-check failed."));
    }
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
    ok: checks.length === 5 && checks.every((check) => check.state === "pass"),
    checkedAt: Date.now(),
    checks,
  };
}
