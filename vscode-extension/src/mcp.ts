import { realpath, readFile, stat } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";

const PROTOCOL_2026 = "2026-07-28";
const PROTOCOL_2025 = "2025-11-25";
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_SEARCH_FILES = 5000;
const MAX_SEARCH_RESULTS = 100;
const SEARCH_EXCLUDE = "**/{node_modules,.git,dist,build,out,coverage,.next,.cache,vendor}/**";

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

interface ToolDefinition {
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

const TOOLS: ToolDefinition[] = [
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
        maxResults: { type: "integer", minimum: 1, maximum: MAX_SEARCH_RESULTS, default: 30 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
];

function normalizeFsPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function workspaceRoots(): Promise<string[]> {
  const roots: string[] = [];
  const seen = new Set<string>();
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme !== "file") continue;
    try {
      const canonical = await realpath(folder.uri.fsPath);
      const key = normalizeFsPath(canonical);
      if (!seen.has(key)) {
        seen.add(key);
        roots.push(canonical);
      }
    } catch {
      // Ignore workspace folders that disappeared after VS Code reported them.
    }
  }
  return roots;
}

async function canonicalWorkspaceFile(file: string, roots?: string[]): Promise<string | null> {
  const workspace = roots ?? (await workspaceRoots());
  try {
    const canonical = await realpath(file);
    const targetKey = normalizeFsPath(canonical);
    return workspace.some((root) => isInside(normalizeFsPath(root), targetKey)) ? canonical : null;
  } catch {
    return null;
  }
}

async function resolveWorkspacePath(input: string, roots: string[]): Promise<string> {
  if (path.isAbsolute(input)) {
    const canonical = await canonicalWorkspaceFile(input, roots);
    if (!canonical) throw new Error("The requested path is outside the open VS Code workspace or does not exist.");
    return canonical;
  }

  const matches = new Map<string, string>();
  for (const root of roots) {
    const candidate = await canonicalWorkspaceFile(path.join(root, input), roots);
    if (candidate) matches.set(normalizeFsPath(candidate), candidate);
  }
  if (matches.size === 0) throw new Error("The requested relative path was not found inside the open workspace.");
  if (matches.size > 1) throw new Error("The requested relative path is ambiguous across multiple workspace folders. Use an absolute path.");
  return [...matches.values()][0]!;
}

async function readWorkspaceText(file: string): Promise<string> {
  const info = await stat(file);
  if (!info.isFile()) throw new Error("The requested path is not a regular file.");
  if (info.size > MAX_FILE_BYTES) throw new Error(`File exceeds the ${MAX_FILE_BYTES} byte read limit.`);
  const bytes = await readFile(file);
  if (bytes.includes(0)) throw new Error("Binary-looking files are not exposed.");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("File is not valid UTF-8 text.");
  }
}

function toolResult(data: unknown, isError = false): Record<string, unknown> {
  return {
    resultType: "complete",
    content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
    ...(typeof data === "object" && data !== null ? { structuredContent: data } : {}),
    ...(isError ? { isError: true } : {}),
  };
}

async function activeEditorView(): Promise<Record<string, unknown>> {
  const roots = await workspaceRoots();
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== "file") {
    return { activeFile: null, languageId: null, dirty: false, content: null, restricted: false };
  }
  const activeFile = await canonicalWorkspaceFile(editor.document.uri.fsPath, roots);
  if (!activeFile) {
    return { activeFile: null, languageId: null, dirty: false, content: null, restricted: true };
  }
  const content = editor.document.getText();
  const bytes = Buffer.byteLength(content, "utf8");
  const exposed = bytes <= MAX_FILE_BYTES ? content : Buffer.from(content, "utf8").subarray(0, MAX_FILE_BYTES).toString("utf8");
  return {
    activeFile,
    languageId: editor.document.languageId,
    dirty: editor.document.isDirty,
    content: exposed,
    contentTruncated: bytes > MAX_FILE_BYTES,
    restricted: false,
  };
}

async function getSelection(): Promise<Record<string, unknown>> {
  const roots = await workspaceRoots();
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== "file") return { activeFile: null, selection: null, restricted: false };
  const activeFile = await canonicalWorkspaceFile(editor.document.uri.fsPath, roots);
  if (!activeFile) return { activeFile: null, selection: null, restricted: true };
  const value = editor.document.getText(editor.selection);
  return {
    activeFile,
    selection: {
      text: value,
      start: { line: editor.selection.start.line, character: editor.selection.start.character },
      end: { line: editor.selection.end.line, character: editor.selection.end.character },
      isEmpty: editor.selection.isEmpty,
    },
    restricted: false,
  };
}

async function getDiagnostics(): Promise<Record<string, unknown>> {
  const roots = await workspaceRoots();
  const diagnostics: Array<Record<string, unknown>> = [];
  let truncated = false;
  for (const [uri, values] of vscode.languages.getDiagnostics()) {
    if (uri.scheme !== "file") continue;
    const file = await canonicalWorkspaceFile(uri.fsPath, roots);
    if (!file) continue;
    for (const item of values) {
      diagnostics.push({
        file,
        message: item.message.slice(0, 4096),
        severity: ["error", "warning", "information", "hint"][item.severity] ?? "hint",
        source: item.source?.slice(0, 256),
        code: typeof item.code === "object" ? item.code.value : item.code,
        range: {
          start: { line: item.range.start.line, character: item.range.start.character },
          end: { line: item.range.end.line, character: item.range.end.character },
        },
      });
      if (diagnostics.length >= 500) {
        truncated = true;
        return { diagnostics, truncated };
      }
    }
  }
  return { diagnostics, truncated };
}

async function searchWorkspace(query: string, maxResults: number): Promise<Record<string, unknown>> {
  const roots = await workspaceRoots();
  const candidates: vscode.Uri[] = [];
  let remaining = MAX_SEARCH_FILES;
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme !== "file" || remaining <= 0) continue;
    const found = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, "**/*"), SEARCH_EXCLUDE, remaining);
    candidates.push(...found);
    remaining = Math.max(0, MAX_SEARCH_FILES - candidates.length);
  }

  const matches: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const needle = query.toLowerCase();
  let filesScanned = 0;
  for (const uri of candidates.slice(0, MAX_SEARCH_FILES)) {
    const file = await canonicalWorkspaceFile(uri.fsPath, roots);
    if (!file) continue;
    const key = normalizeFsPath(file);
    if (seen.has(key)) continue;
    seen.add(key);
    let content: string;
    try {
      content = await readWorkspaceText(file);
    } catch {
      continue;
    }
    filesScanned += 1;
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const column = lines[i]!.toLowerCase().indexOf(needle);
      if (column < 0) continue;
      matches.push({ path: file, line: i + 1, column: column + 1, preview: lines[i]!.slice(0, 500) });
      if (matches.length >= maxResults) return { query, matches, filesScanned, truncated: true };
    }
  }
  return { query, matches, filesScanned, truncated: candidates.length >= MAX_SEARCH_FILES };
}

function objectParams(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

async function callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    switch (name) {
      case "get_workspace": {
        const roots = await workspaceRoots();
        const active = await activeEditorView();
        return toolResult({ vscodeConnected: true, workspaceFolders: roots, activeFile: active.activeFile ?? null });
      }
      case "get_active_editor":
        return toolResult(await activeEditorView());
      case "get_selection":
        return toolResult(await getSelection());
      case "get_diagnostics":
        return toolResult(await getDiagnostics());
      case "read_file": {
        if (typeof args.path !== "string" || args.path.length === 0) return toolResult("path is required.", true);
        const roots = await workspaceRoots();
        const file = await resolveWorkspacePath(args.path, roots);
        const content = await readWorkspaceText(file);
        const lines = content.split(/\r?\n/);
        const start = typeof args.startLine === "number" && Number.isInteger(args.startLine) && args.startLine > 0 ? args.startLine : 1;
        if (start > lines.length) return toolResult(`startLine ${start} exceeds the file length of ${lines.length} lines.`, true);
        const end = typeof args.endLine === "number" && Number.isInteger(args.endLine) && args.endLine > 0 ? args.endLine : lines.length;
        if (end < start) return toolResult("endLine must be greater than or equal to startLine.", true);
        const clampedEnd = Math.min(end, lines.length);
        return toolResult({ path: file, startLine: start, endLine: clampedEnd, content: lines.slice(start - 1, clampedEnd).join("\n") });
      }
      case "search_workspace": {
        if (typeof args.query !== "string" || args.query.length === 0 || args.query.length > 500) return toolResult("query must contain 1 to 500 characters.", true);
        const maxResults = typeof args.maxResults === "number" && Number.isInteger(args.maxResults)
          ? Math.min(MAX_SEARCH_RESULTS, Math.max(1, args.maxResults))
          : 30;
        return toolResult(await searchWorkspace(args.query, maxResults));
      }
      default:
        return toolResult(`Unknown tool: ${name}`, true);
    }
  } catch (error) {
    return toolResult(error instanceof Error ? error.message : "Tool execution failed.", true);
  }
}

function rpcResponse(id: unknown, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result });
}

function rpcError(id: unknown, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

export async function handleMcpRequest(request: CloudMcpRequest): Promise<CloudMcpResponse> {
  const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
  if (request.method === "DELETE") return { type: "mcp_response", requestId: request.requestId, status: 204, headers, body: "" };

  let parsed: JsonRpcRequest;
  try {
    parsed = JSON.parse(request.body) as JsonRpcRequest;
  } catch {
    return { type: "mcp_response", requestId: request.requestId, status: 400, headers, body: rpcError(null, -32700, "Parse error") };
  }
  if (parsed.jsonrpc !== "2.0" || typeof parsed.method !== "string") {
    return { type: "mcp_response", requestId: request.requestId, status: 400, headers, body: rpcError(parsed.id, -32600, "Invalid Request") };
  }

  const protocolVersion = request.headers["mcp-protocol-version"];
  const routedMethod = request.headers["mcp-method"];
  if (protocolVersion === PROTOCOL_2026 && routedMethod !== parsed.method) {
    return { type: "mcp_response", requestId: request.requestId, status: 400, headers, body: rpcError(parsed.id, -32020, "Mcp-Method does not match the JSON-RPC method.") };
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
      result = { protocolVersion: requested.startsWith("2025-") ? requested : PROTOCOL_2025, capabilities: { tools: {} }, serverInfo: { name: "chatgpt-bridge-vscode", version: "0.2.0" } };
      break;
    }
    case "notifications/initialized":
      return { type: "mcp_response", requestId: request.requestId, status: 202, headers, body: "" };
    case "tools/list":
      result = { resultType: "complete", tools: TOOLS, ttlMs: 300_000, cacheScope: "public" };
      break;
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      if (!name) return { type: "mcp_response", requestId: request.requestId, status: 400, headers, body: rpcError(parsed.id, -32602, "Tool name is required.") };
      if (protocolVersion === PROTOCOL_2026) {
        const routedName = request.headers["mcp-name"];
        if (routedName !== name) return { type: "mcp_response", requestId: request.requestId, status: 400, headers, body: rpcError(parsed.id, -32020, "Mcp-Name does not match the requested tool.") };
      }
      result = await callTool(name, objectParams(params.arguments));
      break;
    }
    default:
      return { type: "mcp_response", requestId: request.requestId, status: 404, headers, body: rpcError(parsed.id, -32601, "Method not found") };
  }

  return { type: "mcp_response", requestId: request.requestId, status: 200, headers, body: rpcResponse(parsed.id, result) };
}
