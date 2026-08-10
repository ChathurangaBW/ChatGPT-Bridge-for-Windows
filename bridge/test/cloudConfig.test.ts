import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CLOUD_URL, cloudConfig, websocketUrl } from "../src/cloudConfig.js";

test("cloud relay defaults to the configured workers.dev origin", () => {
  assert.deepEqual(cloudConfig({}), { enabled: true, baseUrl: DEFAULT_CLOUD_URL });
  assert.equal(
    websocketUrl(DEFAULT_CLOUD_URL, "dev_example"),
    "wss://lucky-heart-f5b9.chatgpt-bridge.workers.dev/device/connect?device_id=dev_example",
  );
});

test("cloud relay can be disabled and validates custom origins", () => {
  assert.equal(cloudConfig({ BRIDGE_CLOUD_DISABLED: "true" }).enabled, false);
  assert.deepEqual(cloudConfig({ BRIDGE_CLOUD_URL: "http://127.0.0.1:8787/" }), {
    enabled: true,
    baseUrl: "http://127.0.0.1:8787",
  });
  assert.throws(() => cloudConfig({ BRIDGE_CLOUD_URL: "http://example.com" }), /HTTPS/i);
  assert.throws(() => cloudConfig({ BRIDGE_CLOUD_URL: "https://user:pass@example.com" }), /credentials/i);
});
