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
import {
  normalizePairingCode,
  randomId,
  randomPairingCode,
  randomToken,
  secureEqualText,
  sha256,
} from "./crypto.js";

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

interface RegistrationRate {
  hour: number;
  count: number;
}

const MAX_DEVICE_REGISTRATIONS_PER_HOUR_PER_IP = 20;
const MAX_CLIENT_REGISTRATIONS_PER_HOUR_PER_IP = 100;

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

async function rateKey(kind: string, ip: string): Promise<string> {
  return `rate:${kind}:${await sha256(ip || "unknown")}`;
}

function scopeIsSubset(requested: string, granted: string): boolean {
  const grantedSet = new Set(granted.split(/\s+/).filter(Boolean));
  return requested.split(/\s+/).filter(Boolean).every((scope) => grantedSet.has(scope));
}

export class ControlPlane extends DurableObject<Env> {
  async registerDevice(origin: string, ip: string): Promise<DeviceRegistration> {
    await this.consumeHourlyRate("device", ip, MAX_DEVICE_REGISTRATIONS_PER_HOUR_PER_IP);
    const now = Date.now();
    const deviceId = randomId("dev");
    const deviceSecret = randomToken();
    const secretHash = await sha256(deviceSecret);
    const pairingGeneration = 1;
    const pairing = await this.createPairing(deviceId, pairingGeneration, now);
    const record: DeviceRecord = {
      deviceId,
      secretHash,
      createdAt: now,
      pairingGeneration,
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
    return secureEqualText(await sha256(deviceSecret), record.secretHash);
  }

  async getDeviceStatus(deviceId: string, deviceSecret: string): Promise<DeviceStatus> {
    if (!(await this.verifyDevice(deviceId, deviceSecret))) throw new Error("Invalid device credential.");
    const record = await this.ctx.storage.get<DeviceRecord>(deviceKey(deviceId));
    if (!record) throw new Error("Unknown device.");

    if (record.currentPairingCode && (!record.pairingExpiresAt || record.pairingExpiresAt <= Date.now())) {
      await this.ctx.storage.delete(pairKey(record.currentPairingCode));
      delete record.currentPairingCode;
      delete record.pairingExpiresAt;
      await this.ctx.storage.put(deviceKey(deviceId), record);
    }

    return {
      paired: Boolean(record.pairedAt),
      ...(record.currentPairingCode ? { pairingCode: record.currentPairingCode } : {}),
      ...(record.pairingExpiresAt ? { pairingExpiresAt: record.pairingExpiresAt } : {}),
    };
  }

  async rotatePairing(deviceId: string, deviceSecret: string): Promise<DeviceStatus> {
    if (!(await this.verifyDevice(deviceId, deviceSecret))) throw new Error("Invalid device credential.");
    const record = await this.ctx.storage.get<DeviceRecord>(deviceKey(deviceId));
    if (!record) throw new Error("Unknown device.");

    if (record.currentPairingCode) await this.ctx.storage.delete(pairKey(record.currentPairingCode));
    record.pairingGeneration += 1;
    const pairing = await this.createPairing(deviceId, record.pairingGeneration, Date.now());
    record.currentPairingCode = pairing.pairingCode;
    record.pairingExpiresAt = pairing.pairingExpiresAt;
    await this.ctx.storage.put(deviceKey(deviceId), record);
    return { paired: Boolean(record.pairedAt), ...pairing };
  }

  async registerClient(input: RegisterClientInput, ip = "unknown"): Promise<OAuthClientRecord> {
    await this.consumeHourlyRate("oauth-client", ip, MAX_CLIENT_REGISTRATIONS_PER_HOUR_PER_IP);
    if (input.redirectUris.length === 0 || input.redirectUris.length > 20) throw new Error("redirect_uris is required.");
    for (const uri of input.redirectUris) {
      const parsed = new URL(uri);
      const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
      if (parsed.protocol !== "https:" && !(loopback && parsed.protocol === "http:")) {
        throw new Error("redirect_uris must use HTTPS, except HTTP loopback development redirects.");
      }
      if (parsed.username || parsed.password || parsed.hash) throw new Error("redirect_uris must not contain credentials or fragments.");
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
    if (
      !device ||
      device.pairingGeneration !== pairing.pairingGeneration ||
      device.currentPairingCode !== pairingCode ||
      !device.pairingExpiresAt ||
      device.pairingExpiresAt <= Date.now()
    ) {
      throw new Error("Pairing code is no longer active.");
    }

    const code = randomToken();
    const record: AuthorizationCodeRecord = {
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      deviceId: device.deviceId,
      pairingGeneration: device.pairingGeneration,
      codeChallenge: input.codeChallenge,
      scope: normalizeScope(input.scope),
      resource: input.resource,
      expiresAt: Date.now() + AUTH_CODE_TTL_MS,
    };
    await this.ctx.storage.put(authCodeKey(await sha256(code)), record);
    return code;
  }

  async exchangeAuthorizationCode(input: ExchangeCodeInput): Promise<IssuedTokens> {
    if (input.codeVerifier.length < 43 || input.codeVerifier.length > 128) throw new Error("PKCE verification failed.");
    const key = authCodeKey(await sha256(input.code));
    const verifierChallenge = await sha256(input.codeVerifier);
    const record = await this.ctx.storage.transaction(async (txn) => {
      const current = await txn.get<AuthorizationCodeRecord>(key);
      if (!current) throw new Error("Invalid authorization code.");
      if (current.expiresAt <= Date.now()) {
        await txn.delete(key);
        throw new Error("Authorization code expired.");
      }
      if (current.clientId !== input.clientId || current.redirectUri !== input.redirectUri || current.resource !== input.resource) {
        throw new Error("Authorization code context mismatch.");
      }
      if (!secureEqualText(verifierChallenge, current.codeChallenge)) throw new Error("PKCE verification failed.");
      await txn.delete(key);
      return current;
    });

    const device = await this.ctx.storage.get<DeviceRecord>(deviceKey(record.deviceId));
    if (!device) throw new Error("Paired device no longer exists.");
    if (device.pairingGeneration !== record.pairingGeneration) {
      throw new Error("Authorization code was replaced by a newer pairing attempt.");
    }

    device.pairedAt = Date.now();
    await this.ctx.storage.put(deviceKey(device.deviceId), device);
    return this.issueTokens(record.deviceId, record.clientId, record.scope, record.resource);
  }

  async refresh(input: RefreshInput): Promise<IssuedTokens> {
    const key = refreshKey(await sha256(input.refreshToken));
    const consumed = await this.ctx.storage.transaction(async (txn) => {
      const record = await txn.get<TokenRecord>(key);
      if (!record) throw new Error("Invalid refresh token.");
      if (record.expiresAt <= Date.now()) {
        await txn.delete(key);
        throw new Error("Refresh token expired.");
      }
      if (record.clientId !== input.clientId || record.resource !== input.resource) throw new Error("Refresh token context mismatch.");
      const scope = input.scope ? normalizeScope(input.scope) : record.scope;
      if (!hasRequiredScope(scope) || !scopeIsSubset(scope, record.scope)) {
        throw new Error("Refresh request attempted to broaden the granted scope.");
      }
      await txn.delete(key);
      return { record, scope };
    });

    return this.issueTokens(consumed.record.deviceId, consumed.record.clientId, consumed.scope, consumed.record.resource);
  }

  async introspectAccessToken(accessToken: string, resource: string): Promise<TokenRecord | null> {
    const key = accessKey(await sha256(accessToken));
    const record = await this.ctx.storage.get<TokenRecord>(key);
    if (!record) return null;
    if (record.expiresAt <= Date.now()) {
      await this.ctx.storage.delete(key);
      return null;
    }
    if (record.resource !== resource || !hasRequiredScope(record.scope)) return null;
    return record;
  }

  private async createPairing(
    deviceId: string,
    pairingGeneration: number,
    now: number,
  ): Promise<{ pairingCode: string; pairingExpiresAt: number }> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const pairingCode = randomPairingCode();
      const key = pairKey(pairingCode);
      const existing = await this.ctx.storage.get<PairingRecord>(key);
      if (existing && existing.expiresAt > now) continue;
      const pairingExpiresAt = now + PAIRING_TTL_MS;
      const record: PairingRecord = { deviceId, pairingGeneration, expiresAt: pairingExpiresAt };
      await this.ctx.storage.put(key, record);
      return { pairingCode, pairingExpiresAt };
    }
    throw new Error("Unable to allocate a unique pairing code.");
  }

  private async issueTokens(deviceId: string, clientId: string, scope: string, resource: string): Promise<IssuedTokens> {
    const accessToken = randomToken();
    const accessHash = await sha256(accessToken);
    const now = Date.now();
    const access: TokenRecord = {
      deviceId,
      clientId,
      scope,
      resource,
      expiresAt: now + ACCESS_TOKEN_TTL_MS,
    };

    let refreshToken: string | undefined;
    let refreshHash: string | undefined;
    let refresh: TokenRecord | undefined;
    if (scope.split(/\s+/).includes(OFFLINE_SCOPE)) {
      refreshToken = randomToken();
      refreshHash = await sha256(refreshToken);
      refresh = {
        deviceId,
        clientId,
        scope,
        resource,
        expiresAt: now + REFRESH_TOKEN_TTL_MS,
      };
    }

    await this.ctx.storage.transaction(async (txn) => {
      await txn.put(accessKey(accessHash), access);
      if (refreshHash && refresh) await txn.put(refreshKey(refreshHash), refresh);
    });

    return {
      accessToken,
      ...(refreshToken ? { refreshToken } : {}),
      expiresIn: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      scope,
    };
  }

  private async consumeHourlyRate(kind: string, ip: string, max: number): Promise<void> {
    const currentHour = Math.floor(Date.now() / 3_600_000);
    const key = await rateKey(kind, ip);
    await this.ctx.storage.transaction(async (txn) => {
      const existing = await txn.get<RegistrationRate>(key);
      const count = existing?.hour === currentHour ? existing.count : 0;
      if (count >= max) throw new Error("Too many registration requests from this address. Try again later.");
      await txn.put(key, { hour: currentHour, count: count + 1 } satisfies RegistrationRate);
    });
  }
}
