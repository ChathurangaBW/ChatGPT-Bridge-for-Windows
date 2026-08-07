import assert from "node:assert/strict";
import test from "node:test";
import { bridgePorts } from "../src/config.js";

test("bridgePorts uses defaults and rejects malformed, privileged, and colliding ports", () => {
  assert.deepEqual(bridgePorts({}), { wsPort: 47321, mcpPort: 47322 });
  assert.deepEqual(bridgePorts({ BRIDGE_WS_PORT: "50001", BRIDGE_MCP_PORT: "50002" }), {
    wsPort: 50001,
    mcpPort: 50002,
  });

  assert.throws(() => bridgePorts({ BRIDGE_WS_PORT: "47321abc" }), /integer between 1024 and 65535/i);
  assert.throws(() => bridgePorts({ BRIDGE_WS_PORT: "80" }), /integer between 1024 and 65535/i);
  assert.throws(
    () => bridgePorts({ BRIDGE_WS_PORT: "50000", BRIDGE_MCP_PORT: "50000" }),
    /must be different/i,
  );
});
