export interface BridgePorts {
  wsPort: number;
  mcpPort: number;
}

function parsePort(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) {
    throw new Error(`${name} must be an integer between 1024 and 65535.`);
  }
  return parsed;
}

export function bridgePorts(env: NodeJS.ProcessEnv = process.env): BridgePorts {
  const wsPort = parsePort("BRIDGE_WS_PORT", env.BRIDGE_WS_PORT, 47321);
  const mcpPort = parsePort("BRIDGE_MCP_PORT", env.BRIDGE_MCP_PORT, 47322);
  if (wsPort === mcpPort) throw new Error("BRIDGE_WS_PORT and BRIDGE_MCP_PORT must be different.");
  return { wsPort, mcpPort };
}
