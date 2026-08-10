export const DEFAULT_CLOUD_URL = "https://lucky-heart-f5b9.chatgpt-bridge.workers.dev";

export interface CloudConfig {
  enabled: boolean;
  baseUrl: string;
}

function isTruthy(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value?.trim() ?? "");
}

export function cloudConfig(env: NodeJS.ProcessEnv = process.env): CloudConfig {
  if (isTruthy(env.BRIDGE_CLOUD_DISABLED)) return { enabled: false, baseUrl: DEFAULT_CLOUD_URL };
  const raw = (env.BRIDGE_CLOUD_URL ?? DEFAULT_CLOUD_URL).trim().replace(/\/+$/, "");
  const url = new URL(raw);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
    throw new Error("BRIDGE_CLOUD_URL must use HTTPS, except for localhost development.");
  }
  if (url.username || url.password || url.hash || url.search) {
    throw new Error("BRIDGE_CLOUD_URL must be a plain origin URL without credentials, query parameters, or fragments.");
  }
  return { enabled: true, baseUrl: url.origin };
}

export function websocketUrl(baseUrl: string, deviceId: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/device/connect";
  url.searchParams.set("device_id", deviceId);
  return url.toString();
}
