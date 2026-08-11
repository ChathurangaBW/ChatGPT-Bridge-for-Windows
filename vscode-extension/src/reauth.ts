import * as vscode from "vscode";
import { BRIDGE_ORIGIN } from "./connectionDoctor.js";

const DEVICE_ID_KEY = "chatgptBridge.cloud.deviceId";
const DEVICE_SECRET_KEY = "chatgptBridge.cloud.deviceSecret";
const PAIRING_CODE_KEY = "chatgptBridge.cloud.pairingCode";
const PAIRING_EXPIRES_KEY = "chatgptBridge.cloud.pairingExpiresAt";
const HTTP_TIMEOUT_MS = 15_000;

export interface ReauthenticationPreparation {
  pairingCode: string;
  pairingExpiresAt?: number;
}

interface PairingResponse {
  pairingCode?: unknown;
  pairingExpiresAt?: unknown;
}

export async function prepareChatGptReauthentication(
  context: vscode.ExtensionContext,
  fetchImpl: typeof fetch = fetch,
): Promise<ReauthenticationPreparation> {
  const deviceId = context.globalState.get<string>(DEVICE_ID_KEY);
  const deviceSecret = await context.secrets.get(DEVICE_SECRET_KEY);
  if (!deviceId || !deviceSecret) {
    throw new Error("The VS Code device is not registered yet. Wait for the relay connection, then try again.");
  }

  const url = new URL("/device/pairing", BRIDGE_ORIGIN);
  url.searchParams.set("device_id", deviceId);
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { authorization: `Bearer ${deviceSecret}` },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const text = await response.text();
  let body: PairingResponse | null = null;
  try {
    body = text ? (JSON.parse(text) as PairingResponse) : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    throw new Error(text || `Unable to prepare ChatGPT reauthentication (HTTP ${response.status}).`);
  }
  if (!body || typeof body.pairingCode !== "string" || !body.pairingCode) {
    throw new Error("The Bridge relay did not return a fresh pairing code.");
  }

  const pairingExpiresAt = typeof body.pairingExpiresAt === "number" ? body.pairingExpiresAt : undefined;
  await context.globalState.update(PAIRING_CODE_KEY, body.pairingCode);
  await context.globalState.update(PAIRING_EXPIRES_KEY, pairingExpiresAt);
  await vscode.env.clipboard.writeText(body.pairingCode);

  return {
    pairingCode: body.pairingCode,
    ...(pairingExpiresAt ? { pairingExpiresAt } : {}),
  };
}
