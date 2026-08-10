export const PROTOCOL_2026 = "2026-07-28";
export const PROTOCOL_2025 = "2025-11-25";
export const MAX_MCP_RESPONSE_BYTES = 5 * 1024 * 1024;
export const WORKSPACE_WIDGET_URI = "ui://chatgpt-bridge/workspace-status-v1.html";
export const WORKSPACE_WIDGET_MIME = "text/html;profile=mcp-app";

export const WORKSPACE_WIDGET_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;padding:0;font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;color:CanvasText;background:Canvas}.card{border:1px solid color-mix(in srgb,CanvasText 16%,transparent);border-radius:14px;padding:16px;min-width:260px}.head{display:flex;gap:10px;align-items:center;margin-bottom:12px}.mark{width:32px;height:32px;border-radius:9px;display:grid;place-items:center;background:CanvasText;color:Canvas;font-weight:800}.title{font-weight:700;font-size:15px}.sub{opacity:.65;font-size:12px}.state{display:flex;gap:8px;align-items:center;margin:12px 0}.dot{width:9px;height:9px;border-radius:50%;background:#2fa66a}.row{display:grid;grid-template-columns:92px 1fr;gap:8px;margin-top:8px}.label{opacity:.62}.value{min-width:0;overflow-wrap:anywhere;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px}.folders{margin:5px 0 0;padding-left:18px}.folders li{margin:3px 0;overflow-wrap:anywhere}button{margin-top:14px;border:0;border-radius:8px;padding:8px 11px;background:CanvasText;color:Canvas;cursor:pointer;font:inherit;font-weight:650}button:disabled{opacity:.5;cursor:default}.empty{opacity:.7}</style>
</head>
<body>
<div class="card">
  <div class="head"><div class="mark">C</div><div><div class="title">ChatGPT Bridge</div><div class="sub">Live VS Code workspace</div></div></div>
  <div class="state"><span class="dot"></span><span id="state">Connected to VS Code</span></div>
  <div class="row"><div class="label">Active file</div><div class="value" id="active">—</div></div>
  <div class="row"><div class="label">Workspaces</div><div id="roots" class="value empty">—</div></div>
  <button id="refresh" type="button">Refresh from VS Code</button>
</div>
<script>
(function(){
  var active = document.getElementById('active');
  var roots = document.getElementById('roots');
  var state = document.getElementById('state');
  var refresh = document.getElementById('refresh');
  var pending = new Map();
  var nextId = 1;

  function text(value){ return typeof value === 'string' && value.length ? value : 'None'; }
  function render(data){
    if (!data || typeof data !== 'object') return;
    state.textContent = data.vscodeConnected === false ? 'VS Code unavailable' : 'Connected to VS Code';
    active.textContent = text(data.activeFile);
    var folders = Array.isArray(data.workspaceFolders) ? data.workspaceFolders.filter(function(item){ return typeof item === 'string'; }) : [];
    roots.replaceChildren();
    if (!folders.length) {
      roots.className = 'value empty';
      roots.textContent = 'No workspace folder open';
      return;
    }
    roots.className = 'value';
    var list = document.createElement('ul');
    list.className = 'folders';
    folders.forEach(function(folder){ var item = document.createElement('li'); item.textContent = folder; list.appendChild(item); });
    roots.appendChild(list);
  }

  function request(method, params){
    var id = nextId++;
    window.parent.postMessage({jsonrpc:'2.0',id:id,method:method,params:params}, '*');
    return new Promise(function(resolve,reject){ pending.set(id,{resolve:resolve,reject:reject}); });
  }

  window.addEventListener('message', function(event){
    if (event.source !== window.parent) return;
    var message = event.data;
    if (!message || message.jsonrpc !== '2.0') return;
    if (message.id !== undefined && pending.has(message.id)) {
      var waiter = pending.get(message.id); pending.delete(message.id);
      if (message.error) waiter.reject(message.error); else waiter.resolve(message.result);
      return;
    }
    if (message.method === 'ui/notifications/tool-result') render(message.params && message.params.structuredContent);
  }, {passive:true});

  if (window.openai && window.openai.toolOutput) {
    render(window.openai.toolOutput.structuredContent || window.openai.toolOutput);
  }

  refresh.addEventListener('click', async function(){
    refresh.disabled = true; refresh.textContent = 'Refreshing…';
    try {
      var result = await request('tools/call', {name:'get_workspace',arguments:{}});
      if (result && result.structuredContent) render(result.structuredContent);
    } catch (_) {
      state.textContent = 'Could not refresh VS Code';
    } finally {
      refresh.disabled = false; refresh.textContent = 'Refresh from VS Code';
    }
  });
})();
</script>
</body>
</html>`;

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
  _meta?: Record<string, unknown>;
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
    _meta: {
      ui: { resourceUri: WORKSPACE_WIDGET_URI },
      "openai/outputTemplate": WORKSPACE_WIDGET_URI,
      "openai/widgetAccessible": true,
      "openai/toolInvocation/invoking": "Checking VS Code workspace…",
      "openai/toolInvocation/invoked": "VS Code workspace ready.",
    },
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

const TOOL_NAMES = new Set(TOOLS.map((tool) => tool.name));

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

function response(request: CloudMcpRequest, status: number, body: string): CloudMcpResponse {
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

function workspaceResource() {
  return {
    uri: WORKSPACE_WIDGET_URI,
    name: "chatgpt-bridge-workspace-status",
    title: "ChatGPT Bridge workspace status",
    description: "Inline status card for the currently connected VS Code workspace.",
    mimeType: WORKSPACE_WIDGET_MIME,
  };
}

function workspaceResourceContents() {
  return {
    uri: WORKSPACE_WIDGET_URI,
    mimeType: WORKSPACE_WIDGET_MIME,
    text: WORKSPACE_WIDGET_HTML,
    _meta: {
      ui: {
        prefersBorder: true,
        csp: { connectDomains: [], resourceDomains: [] },
      },
      "openai/widgetDescription": "Shows the live VS Code workspace connected through ChatGPT Bridge.",
    },
  };
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
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "chatgpt-bridge-vscode", version: "0.2.0" },
        instructions: "Read-only access to the currently focused VS Code workspace. Files outside the open workspace are withheld.",
      };
      break;
    case "initialize": {
      const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_2025;
      result = {
        protocolVersion: requested.startsWith("2025-") ? requested : PROTOCOL_2025,
        capabilities: { tools: {}, resources: {} },
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
      if (!TOOL_NAMES.has(name)) return response(request, 404, rpcError(parsed.id, -32602, `Unknown tool: ${name}`));
      if (protocolVersion === PROTOCOL_2026) {
        const routedName = request.headers["mcp-name"];
        if (routedName !== name) {
          return response(request, 400, rpcError(parsed.id, -32020, "Mcp-Name does not match the requested tool."));
        }
      }
      result = await callTool(name, objectParams(params.arguments));
      break;
    }
    case "resources/list":
      result = { resources: [workspaceResource()] };
      break;
    case "resources/read": {
      const uri = typeof params.uri === "string" ? params.uri : "";
      if (!uri) return response(request, 400, rpcError(parsed.id, -32602, "Resource URI is required."));
      if (uri !== WORKSPACE_WIDGET_URI) return response(request, 404, rpcError(parsed.id, -32004, `Unknown resource: ${uri}`));
      result = { contents: [workspaceResourceContents()] };
      break;
    }
    default:
      return response(request, 404, rpcError(parsed.id, -32601, "Method not found"));
  }

  return boundedResponse(request, parsed.id, result);
}
