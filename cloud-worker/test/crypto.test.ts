import assert from "node:assert/strict";
import test from "node:test";
import { normalizePairingCode, randomPairingCode, sha256, verifyPkceS256 } from "../src/crypto.js";
import { MCP_SCOPE, OFFLINE_SCOPE, hasRequiredScope, normalizeScope } from "../src/protocol.js";

test("pairing codes are normalized and retain 12 unambiguous symbols", () => {
  const code = randomPairingCode();
  assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(normalizePairingCode(code.toLowerCase().replaceAll("-", " ")), code);
  assert.equal(normalizePairingCode("too-short"), "");
});

test("PKCE S256 verification accepts the matching verifier only", async () => {
  const verifier = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-._~";
  const challenge = await sha256(verifier);
  assert.equal(await verifyPkceS256(verifier, challenge), true);
  assert.equal(await verifyPkceS256(`${verifier}x`, challenge), false);
  assert.equal(await verifyPkceS256("short", challenge), false);
});

test("OAuth scopes always include bridge read and retain offline access when requested", () => {
  assert.equal(normalizeScope(undefined), MCP_SCOPE);
  assert.equal(normalizeScope(OFFLINE_SCOPE), `${MCP_SCOPE} ${OFFLINE_SCOPE}`);
  assert.equal(hasRequiredScope(normalizeScope(OFFLINE_SCOPE)), true);
});
