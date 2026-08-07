import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function bridgeSecretPath(): string {
  const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  return path.join(localAppData, "ChatGPTBridge", "bridge-token");
}

export async function readBridgeSecret(): Promise<string> {
  const token = (await readFile(bridgeSecretPath(), "utf8")).trim();
  if (token.length < 32) throw new Error("Bridge pairing token is invalid.");
  return token;
}
