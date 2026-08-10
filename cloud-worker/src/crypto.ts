const TOKEN_BYTES = 32;
const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function randomToken(bytes = TOKEN_BYTES): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return base64Url(value);
}

export function randomId(prefix: string): string {
  return `${prefix}_${randomToken(18)}`;
}

export function randomPairingCode(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let raw = "";
  for (const byte of bytes) raw += PAIRING_ALPHABET[byte % PAIRING_ALPHABET.length];
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

export function normalizePairingCode(input: string): string {
  const raw = input.toUpperCase().replace(/[^A-Z2-9]/g, "");
  if (raw.length !== 12) return "";
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

export async function sha256(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return base64Url(new Uint8Array(digest));
}

export function secureEqualText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

export async function verifyPkceS256(verifier: string, expectedChallenge: string): Promise<boolean> {
  if (verifier.length < 43 || verifier.length > 128) return false;
  return secureEqualText(await sha256(verifier), expectedChallenge);
}
