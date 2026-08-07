import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function bridgeSecretPath(): string {
  const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  return path.join(localAppData, "ChatGPTBridge", "bridge-token");
}

export async function ensureBridgeSecret(): Promise<string> {
  const tokenPath = bridgeSecretPath();
  await mkdir(path.dirname(tokenPath), { recursive: true });

  try {
    const existing = (await readFile(tokenPath, "utf8")).trim();
    if (existing.length >= 32) {
      return existing;
    }
  } catch {
    // First start: create a token below.
  }

  const token = randomBytes(32).toString("hex");
  await writeFile(tokenPath, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    await chmod(tokenPath, 0o600);
  } catch {
    // Windows ACL semantics differ from POSIX modes. Loopback binding + possession of
    // this per-user file are still required by the local protocol.
  }
  return token;
}
