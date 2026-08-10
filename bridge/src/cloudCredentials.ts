import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface CloudDeviceCredentials {
  version: 1;
  baseUrl: string;
  deviceId: string;
  deviceSecret: string;
  pairingCode?: string;
  pairingExpiresAt?: number;
}

export function cloudCredentialsPath(): string {
  const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  return path.join(localAppData, "ChatGPTBridge", "cloud-device.json");
}

export async function loadCloudCredentials(baseUrl: string): Promise<CloudDeviceCredentials | null> {
  try {
    const parsed = JSON.parse(await readFile(cloudCredentialsPath(), "utf8")) as Partial<CloudDeviceCredentials>;
    if (
      parsed.version !== 1 ||
      parsed.baseUrl !== baseUrl ||
      typeof parsed.deviceId !== "string" ||
      !parsed.deviceId.startsWith("dev_") ||
      typeof parsed.deviceSecret !== "string" ||
      parsed.deviceSecret.length < 32
    ) {
      return null;
    }
    return parsed as CloudDeviceCredentials;
  } catch {
    return null;
  }
}

export async function saveCloudCredentials(credentials: CloudDeviceCredentials): Promise<void> {
  const target = cloudCredentialsPath();
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(credentials, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    await chmod(target, 0o600);
  } catch {
    // On Windows the current user account remains part of the trusted computing base.
  }
}
