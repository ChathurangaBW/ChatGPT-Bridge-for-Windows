export const MCP_SCOPE = "bridge:read";
export const OFFLINE_SCOPE = "offline_access";
export const MAX_MCP_BODY_BYTES = 6 * 1024 * 1024;
export const PAIRING_TTL_MS = 10 * 60 * 1000;
export const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const RELAY_TIMEOUT_MS = 30_000;

export interface DeviceRecord {
  deviceId: string;
  secretHash: string;
  createdAt: number;
  pairedAt?: number;
  pairingGeneration: number;
  currentPairingCode?: string;
  pairingExpiresAt?: number;
}

export interface PairingRecord {
  deviceId: string;
  pairingGeneration: number;
  expiresAt: number;
}

export interface OAuthClientRecord {
  clientId: string;
  clientName?: string;
  redirectUris: string[];
  createdAt: number;
}

export interface AuthorizationCodeRecord {
  clientId: string;
  redirectUri: string;
  deviceId: string;
  pairingGeneration: number;
  codeChallenge: string;
  scope: string;
  resource: string;
  expiresAt: number;
}

export interface TokenRecord {
  deviceId: string;
  clientId: string;
  scope: string;
  resource: string;
  expiresAt: number;
}

export interface DeviceRegistration {
  deviceId: string;
  deviceSecret: string;
  pairingCode: string;
  pairingExpiresAt: number;
  pairingUrl: string;
  websocketUrl: string;
}

export interface CloudMcpRequest {
  type: "mcp_request";
  requestId: string;
  method: "POST" | "DELETE";
  headers: Record<string, string>;
  body: string;
}

export interface CloudMcpResponse {
  type: "mcp_response";
  requestId: string;
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface CloudAgentHello {
  type: "agent_hello";
  deviceId: string;
  version: string;
}

export interface CloudAgentReady {
  type: "agent_ready";
  deviceId: string;
}

export function normalizeScope(raw: string | null | undefined): string {
  const requested = new Set((raw ?? MCP_SCOPE).split(/\s+/).filter(Boolean));
  requested.add(MCP_SCOPE);
  const allowed = [MCP_SCOPE, OFFLINE_SCOPE];
  return allowed.filter((scope) => requested.has(scope)).join(" ");
}

export function hasRequiredScope(scope: string): boolean {
  return scope.split(/\s+/).includes(MCP_SCOPE);
}
