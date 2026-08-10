import { DurableObject } from "cloudflare:workers";
import {
  ACCESS_TOKEN_TTL_MS,
  AUTH_CODE_TTL_MS,
  MCP_SCOPE,
  OFFLINE_SCOPE,
  PAIRING_TTL_MS,
  REFRESH_TOKEN_TTL_MS,
  type AuthorizationCodeRecord,
  type DeviceRecord,
  type DeviceRegistration,
  type OAuthClientRecord,
  type PairingRecord,
  type TokenRecord,
  hasRequiredScope,
  normalizeScope,
} from "./protocol.js";
import { normalizePairingCode, randomId, randomPairingCode, randomToken, sha256, verifyPkceS256 } from "./crypto.js";

interface Env {}

interface RegisterClientInput {
  clientName?: string;
  redirectUris: string[];
}

interface AuthorizeInput {
  pairingCode: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  resource: string;
}

interface ExchangeCodeInput {
  code: string;
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
  resource: string;
}

interface RefreshInput {
  refreshToken: string;
  clientId: string;
  resource: string;
  scope?: string;
}

interface IssuedTokens {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  scope: string;
}

interface DeviceStatus {
  paired: boolean;
  pairingCode?: string;
  pairingExpiresAt?: number;
}

const MAX_REGISTRATIONS_PER_HOUR_PER_IP = 20;

function deviceKey(deviceId: string): string {
  return `device:${deviceId}`;
}

function pairKey(pairingCode: string): string {
  return `pair:${pairingCode}`;
}

function clientKey(clientId: string): string {
  return `client:${clientId}`;
}

function authCodeKey(hash: string): string {
  return `code:${hash}`;
}

function accessKey(hash: string): string {
  return `access:${hash}`;
}

function refreshKey(hash: string): string {
  return `refresh:${hash}`;
}

function rateKey(ip: string, now: number): string {
  return `rate:register:${ip}:${Math.floor(now / 3_600_000)}`;
}

export class ControlPlane extends DurableObject<Env> {
  async registerDevice(origin: string, ip: string): Promise<DeviceRegistration> {
    const now = Date.now();
    const key = rateKey(ip || "unknown", now);
    const count = (await this.ctx.storage.get<number>(key)) ?? 0;
    if (count >= MAX_REGISTRATIONS_PER_HOUR_PER_IP) {
      throw new Error("Too many device registrations from this address. Try again later.");
    }
    await this.ctx.storage.put(key, count + 1, { expirationTtl: 7_200 });

    const deviceId = randomId("dev");
    const deviceSecret = randomToken();
    const secretHash = await sha256(deviceSecret);
    const pairing = await this.createPairing(deviceId, now);
    const record: DeviceRecord = {
      deviceId,
      secretHash,
      createdAt: now,
      currentPairingCode: pairing.pairingCode,
      pairingExpiresAt: pairing.pairingExpiresAt,
    };
    await this.ctx.storage.put(deviceKey(deviceId), record);

    const wsOrigin = origin.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
    return {
      deviceId,
      deviceSecret,
      pairingCode: pairing.pairingCode,
      pairingExpiresAt: pairing.pairingExpiresAt,
      pairingUrl: `${origin}/pair/${encodeURIComponent(pairing.pairingCode)}`,
      websocketUrl: `${wsOrigin}/device/connect?device_id=${encodeURIComponent(deviceId)}`,
    };
  }

  async verifyDevice(deviceId: string, deviceSecret: string): Promise<boolean> {
    const record = await this.ctx.storage.get<DeviceRecord>(deviceKey(deviceId));
    if (!record) return false;
    return (await sha256(deviceSecret)) === record.secretHash;
  }

  async getDeviceStatus(deviceId: string, deviceSecret: string): Promise<DeviceStatus> {
    if (!(await this.verifyDevice(deviceId, deviceSecret))) throw new Error("Invalid device credential.");
    const record = await this.ctx.storage.get<DeviceRecord>(deviceKey(deviceId));
    if (!record) throw new Error("Unknown device.");
    const paired = Boolean(record.pairedAt);
    if (paired) return { paired: true };
    return {
      paired: false,
      ...(record.currentPairingCode ? { pairingCode: record.currentPairingCode } : {}),
      ...(record.pairingExpiresAt ? { pairingExpiresAt: record.pairingExpiresAt } : {}),
    };
  }

  async rotatePairing(deviceId: string, deviceSecret: string): Promise<DeviceStatus> {
    if (!(await this.verifyDevice(deviceId, deviceSecret))) throw new Error("Invalid device credential.");
    const record = await this.ctx.storage.get<DeviceRecord>(deviceKey(deviceId));
    if (!record) throw new Error("Unknown device.");
    if (record.pairedAt) return { paired: true };

    if (record.currentPairingCode) await this.ctx.storage.delete(pairKey(record.currentPairingCode));
    const pairing = await this.createPairing(deviceId, Date.now());
    record.currentPairingCode = pairing.pairingCode;
    record.pairingExpiresAt = pairing.pairingExpiresAt;
    await this.ctx.storage.put(deviceKey(deviceId), record);
    return { paired: false, ...pairing };
  }

  async registerClient(input: RegisterClientInput): Promise<OAuthClientRecord> {
    if (input.redirectUris.length === 0 || input.redirectUris.length > 20) throw new Error("redirect_uris is required.");
    for (const uri of input.redirectUris) {
      const parsed = new URL(uri);
      if (parsed.protocol !== "https:" && parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
        throw new Error("redirect_uris must use HTTPS, except loopback development redirects.");
      }
      if (parsed.hash) throw new Error("redirect_uris must not contain fragments.");
    }

    const record: OAuthClientRecord = {
      clientId: randomId("client"),
      ...(input.clientName ? { clientName: input.clientName.slice(0, 200) } : {}),
      redirectUris: [...new Set(input.redirectUris)],
      createdAt: Date.now(),
    };
    await this.ctx.storage.put(clientKey(record.clientId), record);
    return record;
  }

  async getClient(clientId: string): Promise<OAuthClientRecord | null> {
    return (await this.ctx.storage.get<OAuthClientRecord>(clientKey(clientId))) ?? null;
  }

  async authorize(input: AuthorizeInput): Promise<string> {
    const client = await this.getClient(input.clientId);
    if (!client || !client.redirectUris.includes(input.redirectUri)) throw new Error("Invalid OAuth client or redirect URI.");
    if (!input.codeChallenge || input.codeChallenge.length < 43) throw new Error("PKCE S256 code challenge is required.");
    if (!hasRequiredScope(input.scope)) throw new Error(`OAuth scope must include ${MCP_SCOPE}.`);

    const pairingCode = normalizePairingCode(input.pairingCode);
    if (!pairingCode) throw new Error("Invalid pairing code format.");
    const pairing = await this.ctx.storage.get<PairingRecord>(pairKey(pairingCode));
    if (!pairing || pairing.expiresAt <= Date.now()) {
      if (pairing) await this.ctx.storage.delete(pairKey(pairingCode));
      throw new Error("Pairing code is invalid or expired.");
    }

    const device = await this.ctx.storage.get<DeviceRecord>(deviceKey(pairing.deviceId));
    if (!device || device.currentPairingCode !== pairingCode) throw new Error("Pairing code is no longer active.");

    await this.ctx.storage.delete(pairKey(pairingCode));
    device.pairedAt = Date.now();
    delete device.currentPairingCode;
    delete device.pairingExpiresAt;
    await this.ctx.storage.put(deviceKey(device.deviceId), device);

    const code = randomToken();
    const record: AuthorizationCodeRecord = {
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      deviceId: device.deviceId,
      codeChallenge: input.codeChallenge,
      scope: normalizeScope(input.scope),
      resource: input.resource,
      expiresAt: Date.now() + AUTH_CODE_TTL_MS,
    };
    await this.ctx.storage.put(authCodeKey(await sha256(code)), record, { expirationTtl: Math.ceil(AUTH_CODE_TTL_MS / 1000) });
    return code;
  }

  async exchangeAuthorizationCode(input: ExchangeCodeInput): Promise<IssuedTokens> {
    const hash = await sha256(input.code);
    const key = authCodeKey(hash);
    const record = await this.ctx.storage.get<AuthorizationCodeRecord>(key);
    if (!record) throw new Error("Invalid authorization code.");
    await this.ctx.storage.delete(key);
    if (record.expiresAt <= Date.now()) throw new Error("Authorization code expired.");
    if (record.clientId !== input.clientId || record.redirectUri !== input.redirectUri || record.resource !== input.resource) {
      throw new Error("Authorization code context mismatch.");
    }
    if (!(await verifyPkceS256(input.codeVerifier, record.codeChallenge))) throw new Error("PKCE verification failed.");
    return this.issueTokens(record.deviceId, record.clientId, record.scope, record.resource);
  }

  async refresh(input: RefreshInput): Promise<IssuedTokens> {
    const hash = await sha256(input.refreshToken);
    const key = refreshKey(hash);
    const record = await this.ctx.storage.get<TokenRecord>(key);
    if (!record) throw new Error("Invalid refresh token.");
    await this.ctx.storage.delete(key);
    if (record.expiresAt <= Date.now()) throw new Error("Refresh token expired.");
    if (record.clientId !== input.clientId || record.resource !== input.resource) throw new Error("Refresh token context mismatch.");
    const scope = input.scope ? normalizeScope(input.scope) : record.scope;
    if (!hasRequiredScope(scope)) throw new Error(`OAuth scope must include ${MCP_SCOPE}.`);
    return this.issueTokens(record.deviceId, record.clientId, scope, record.resource);
  }

  async introspectAccessToken(accessToken: string, resource: string): Promise<TokenRecord | null> {
    const record = await this.ctx.storage.get<TokenRecord>(accessKey(await sha256(accessToken)));
    if (!record || record.expiresAt <= Date.now() || record.resource !== resource || !hasRequiredScope(record.scope)) return null;
    return record;
  }

  private async createPairing(deviceId: string, now: number): Promise<{ pairingCode: string; pairingExpiresAt: number }> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const pairingCode = randomPairingCode();
      const key = pairKey(pairingCode);
      if (await this.ctx.storage.get(key)) continue;
      const pairingExpiresAt = now + PAIRING_TTL_MS;
      const record: PairingRecord = { deviceId, expiresAt: pairingExpiresAt };
      await this.ctx.storage.put(key, record, { expirationTtl: Math.ceil(PAIRING_TTL_MS / 1000) });
      return { pairingCode, pairingExpiresAt };
    }
    throw new Error("Unable to allocate a unique pairing code.");
  }

  private async issueTokens(deviceId: string, clientId: string, scope: string, resource: string): Promise<IssuedTokens> {
    const accessToken = randomToken();
    const access: TokenRecord = {
      deviceId,
      clientId,
      scope,
      resource,
      expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS,
    };
    await this.ctx.storage.put(accessKey(await sha256(accessToken)), access, {
      expirationTtl: Math.ceil(ACCESS_TOKEN_TTL_MS / 1000),
    });

    let refreshToken: string | undefined;
    if (scope.split(/\s+/).includes(OFFLINE_SCOPE)) {
      refreshToken = randomToken();
      const refresh: TokenRecord = {
        deviceId,
        clientId,
        scope,
        resource,
        expiresAt: Date.now() + REFRESH_TOKEN_TTL_MS,
      };
      await this.ctx.storage.put(refreshKey(await sha256(refreshToken)), refresh, {
        expirationTtl: Math.ceil(REFRESH_TOKEN_TTL_MS / 1000),
      });
    }

    return {
      accessToken,
      ...(refreshToken ? { refreshToken } : {}),
      expiresIn: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      scope,
    };
  }
}
