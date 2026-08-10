export interface MigratedDeviceCredentials {
  deviceId: string;
  deviceSecret: string;
  pairingCode?: string;
  pairingExpiresAt?: number;
}

interface LegacyCredentialFile {
  baseUrl?: unknown;
  deviceId?: unknown;
  deviceSecret?: unknown;
  pairingCode?: unknown;
  pairingExpiresAt?: unknown;
}

export function parseLegacyCredentials(raw: string, expectedBaseUrl: string): MigratedDeviceCredentials | null {
  let parsed: LegacyCredentialFile;
  try {
    parsed = JSON.parse(raw) as LegacyCredentialFile;
  } catch {
    return null;
  }
  if (
    parsed.baseUrl !== expectedBaseUrl ||
    typeof parsed.deviceId !== "string" ||
    typeof parsed.deviceSecret !== "string" ||
    parsed.deviceId.length === 0 ||
    parsed.deviceSecret.length < 32
  ) {
    return null;
  }
  return {
    deviceId: parsed.deviceId,
    deviceSecret: parsed.deviceSecret,
    ...(typeof parsed.pairingCode === "string" ? { pairingCode: parsed.pairingCode } : {}),
    ...(typeof parsed.pairingExpiresAt === "number" && Number.isFinite(parsed.pairingExpiresAt)
      ? { pairingExpiresAt: parsed.pairingExpiresAt }
      : {}),
  };
}
