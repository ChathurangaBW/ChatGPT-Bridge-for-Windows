export const PROTOCOL_2026 = "2026-07-28";
export const PROTOCOL_2025 = "2025-11-25";
export const MAX_MCP_RESPONSE_BYTES = 5 * 1024 * 1024;

export interface CloudMcpRequest {
  type: "mcp_request";
  requestId: string;
  method: "POST" | "DELETE";
  headers: Record<string, string>;
  body: string;
}

export interface CloudMcpResponse {
  type: "mcp_response";
  requestId: string;
  status: number;
  headers: Record<string, string>;
  body: string;
}

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    readOnlyHint: true;
    destructiveHint: false;
    openWorldHint: false;
  };
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
const EMPTY_SCHEMA = { type: "object", properties: {}, additionalProperties: false };

export const TOOLS: ToolDefinition[] = [
  {
    name: "get_workspace",
    title: "Get VS Code workspace",
    description: "Get the currently open VS Code workspace folders and active workspace file.",
    inputSchema: EMPTY_SCHEMA,
    annotations: READ_ONLY,
  },
  {
    name: "get_active_editor",
    title: "Get active VS Code editor",
    description: "Read the active workspace editor and its live unsaved buffer. Files outside the workspace are withheld.",
    inputSchema: EMPTY_SCHEMA,
    annotations: READ_ONLY,
  },
  {
    name: "get_selection",
    title: "Get VS Code selection",
    description: "Read the current selection in the active workspace editor. Files outside the workspace are withheld.",
    inputSchema: EMPTY_SCHEMA,
    annotations: READ_ONLY,
  },
  {
    name: "get_diagnostics",
    title: "Get VS Code diagnostics",
    description: "Get current errors, warnings, information, and hints for files inside the open workspace.",
    inputSchema: EMPTY_SCHEMA,
    annotations: READ_ONLY,
  },
  {
    name: "read_file",
    title: "Read workspace file",
    description: "Read an existing UTF-8 text file inside an open VS Code workspace folder.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1, description: "Absolute workspace path, or a relative path unique across workspace folders." },
        startLine: { type: "integer", minimum: 1 },
        endLine: { type: "integer", minimum: 1 },
      },
      required: ["path"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "search_workspace",
    title: "Search VS Code workspace",
    description: "Literal case-insensitive text search across bounded UTF-8 files in the open workspace.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 500 },
        maxResults: { type: "integer", minimum: 1, maximum: 100, default: 30 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
];

export type ToolCaller = (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;

function objectParams(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function rpcResponse(id: unknown, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result });
}

function rpcError(id: unknown, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

function response(
  request: CloudMcpRequest,
  status: number,
  body: string,
): CloudMcpResponse {
  return {
    type: "mcp_response",
    requestId: request.requestId,
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    body,
  };
}

function boundedResponse(request: CloudMcpRequest, id: unknown, result: unknown): CloudMcpResponse {
  const body = rpcResponse(id, result);
  if (Buffer.byteLength(body, "utf8") <= MAX_MCP_RESPONSE_BYTES) return response(request, 200, body);
  return response(request, 413, rpcError(id, -32002, "MCP tool response exceeded the configured size limit."));
}

export async function handleMcpRequestCore(request: CloudMcpRequest, callTool: ToolCaller): Promise<CloudMcpResponse> {
  if (request.method === "DELETE") {
    return {
      type: "mcp_response",
      requestId: request.requestId,
      status: 204,
      headers: { "cache-control": "no-store" },
      body: "",
    };
  }

  let parsed: JsonRpcRequest;
  try {
    parsed = JSON.parse(request.body) as JsonRpcRequest;
  } catch {
    return response(request, 400, rpcError(null, -32700, "Parse error"));
  }
  if (parsed.jsonrpc !== "2.0" || typeof parsed.method !== "string") {
    return response(request, 400, rpcError(parsed.id, -32600, "Invalid Request"));
  }

  const protocolVersion = request.headers["mcp-protocol-version"];
  const routedMethod = request.headers["mcp-method"];
  if (protocolVersion === PROTOCOL_2026 && routedMethod !== parsed.method) {
    return response(request, 400, rpcError(parsed.id, -32020, "Mcp-Method does not match the JSON-RPC method."));
  }

  const params = objectParams(parsed.params);
  let result: unknown;
  switch (parsed.method) {
    case "server/discover":
      result = {
        resultType: "complete",
        supportedVersions: [PROTOCOL_2026, PROTOCOL_2025],
        capabilities: { tools: {} },
        serverInfo: { name: "chatgpt-bridge-vscode", version: "0.2.0" },
        instructions: "Read-only access to the currently focused VS Code workspace. Files outside the open workspace are withheld.",
      };
      break;
    case "initialize": {
      const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_2025;
      result = {
        protocolVersion: requested.startsWith("2025-") ? requested : PROTOCOL_2025,
        capabilities: { tools: {} },
        serverInfo: { name: "chatgpt-bridge-vscode", version: "0.2.0" },
      };
      break;
    }
    case "notifications/initialized":
      return response(request, 202, "");
    case "tools/list":
      result = { resultType: "complete", tools: TOOLS, ttlMs: 300_000, cacheScope: "public" };
      break;
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      if (!name) return response(request, 400, rpcError(parsed.id, -32602, "Tool name is required."));
      if (protocolVersion === PROTOCOL_2026) {
        const routedName = request.headers["mcp-name"];
        if (routedName !== name) {
          return response(request, 400, rpcError(parsed.id, -32020, "Mcp-Name does not match the requested tool."));
        }
      }
      result = await callTool(name, objectParams(params.arguments));
      break;
    }
    default:
      return response(request, 404, rpcError(parsed.id, -32601, "Method not found"));
  }

  return boundedResponse(request, parsed.id, result);
}
