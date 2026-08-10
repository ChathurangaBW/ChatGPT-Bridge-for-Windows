import assert from "node:assert/strict";
import test from "node:test";
import { parseLegacyCredentials } from "../src/legacyCredentials.js";

const origin = "https://lucky-heart-f5b9.chatgpt-bridge.workers.dev";

test("legacy EXE credential parser accepts only the production origin and strong device credentials", () => {
  const valid = parseLegacyCredentials(JSON.stringify({
    baseUrl: origin,
    deviceId: "dev_example",
    deviceSecret: "s".repeat(64),
    pairingCode: "ABCD-EFGH-JKLM",
    pairingExpiresAt: 123456789,
  }), origin);
  assert.deepEqual(valid, {
    deviceId: "dev_example",
    deviceSecret: "s".repeat(64),
    pairingCode: "ABCD-EFGH-JKLM",
    pairingExpiresAt: 123456789,
  });

  assert.equal(parseLegacyCredentials("{", origin), null);
  assert.equal(parseLegacyCredentials(JSON.stringify({ baseUrl: "https://evil.example", deviceId: "dev_example", deviceSecret: "s".repeat(64) }), origin), null);
  assert.equal(parseLegacyCredentials(JSON.stringify({ baseUrl: origin, deviceId: "", deviceSecret: "s".repeat(64) }), origin), null);
  assert.equal(parseLegacyCredentials(JSON.stringify({ baseUrl: origin, deviceId: "dev_example", deviceSecret: "short" }), origin), null);
});
