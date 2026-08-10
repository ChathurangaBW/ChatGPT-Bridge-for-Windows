import { realpath } from "node:fs/promises";
import * as vscode from "vscode";
import {
  MAX_DIAGNOSTICS,
  MAX_DIAGNOSTIC_MESSAGE_BYTES,
  MAX_DIAGNOSTIC_SOURCE_BYTES,
  MAX_FILE_BYTES,
  MAX_SEARCH_FILES,
  MAX_SEARCH_RESULTS,
  MAX_SELECTION_BYTES,
  SEARCH_EXCLUDE,
  canonicalWorkspaceFile,
  findLiteralMatches,
  normalizeFsPath,
  readWorkspaceText,
  resolveWorkspacePath,
  sanitizeDiagnosticCode,
  selectLineRange,
  truncateUtf8,
  type SearchMatch,
} from "./workspaceSecurity.js";
import {
  handleMcpRequestCore,
  type CloudMcpRequest,
  type CloudMcpResponse,
} from "./mcpProtocol.js";

export type { CloudMcpRequest, CloudMcpResponse } from "./mcpProtocol.js";

function toolResult(data: unknown, isError = false): Record<string, unknown> {
  return {
    resultType: "complete",
    content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
    ...(typeof data === "object" && data !== null ? { structuredContent: data } : {}),
    ...(isError ? { isError: true } : {}),
  };
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

async function activeWorkspaceFile(roots: string[]): Promise<string | null> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== "file") return null;
  return canonicalWorkspaceFile(editor.document.uri.fsPath, roots);
}

async function activeEditorView(): Promise<Record<string, unknown>> {
  const roots = await workspaceRoots();
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== "file") {
    return { activeFile: null, languageId: null, dirty: false, content: null, contentTruncated: false, restricted: false };
  }
  const activeFile = await canonicalWorkspaceFile(editor.document.uri.fsPath, roots);
  if (!activeFile) {
    return { activeFile: null, languageId: null, dirty: false, content: null, contentTruncated: false, restricted: true };
  }
  const content = truncateUtf8(editor.document.getText(), MAX_FILE_BYTES);
  return {
    activeFile,
    languageId: editor.document.languageId,
    dirty: editor.document.isDirty,
    content: content.text,
    contentTruncated: content.truncated,
    restricted: false,
  };
}

async function getSelection(): Promise<Record<string, unknown>> {
  const roots = await workspaceRoots();
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== "file") {
    return { activeFile: null, selection: null, restricted: false };
  }
  const activeFile = await canonicalWorkspaceFile(editor.document.uri.fsPath, roots);
  if (!activeFile) return { activeFile: null, selection: null, restricted: true };

  const value = truncateUtf8(editor.document.getText(editor.selection), MAX_SELECTION_BYTES);
  return {
    activeFile,
    selection: {
      text: value.text,
      start: { line: editor.selection.start.line, character: editor.selection.start.character },
      end: { line: editor.selection.end.line, character: editor.selection.end.character },
      isEmpty: editor.selection.isEmpty,
      truncated: value.truncated,
    },
    restricted: false,
  };
}

async function getDiagnostics(): Promise<Record<string, unknown>> {
  const roots = await workspaceRoots();
  const diagnostics: Array<Record<string, unknown>> = [];
  for (const [uri, values] of vscode.languages.getDiagnostics()) {
    if (uri.scheme !== "file") continue;
    const file = await canonicalWorkspaceFile(uri.fsPath, roots);
    if (!file) continue;
    for (const item of values) {
      const rawCode = typeof item.code === "object" && item.code !== null ? item.code.value : item.code;
      diagnostics.push({
        file,
        message: truncateUtf8(item.message, MAX_DIAGNOSTIC_MESSAGE_BYTES).text,
        severity: ["error", "warning", "information", "hint"][item.severity] ?? "hint",
        source: item.source ? truncateUtf8(item.source, MAX_DIAGNOSTIC_SOURCE_BYTES).text : undefined,
        code: sanitizeDiagnosticCode(rawCode),
        range: {
          start: { line: item.range.start.line, character: item.range.start.character },
          end: { line: item.range.end.line, character: item.range.end.character },
        },
      });
      if (diagnostics.length >= MAX_DIAGNOSTICS) return { diagnostics, truncated: true };
    }
  }
  return { diagnostics, truncated: false };
}

async function searchWorkspace(query: string, maxResults: number): Promise<Record<string, unknown>> {
  const roots = await workspaceRoots();
  const candidates: vscode.Uri[] = [];
  let remainingFiles = MAX_SEARCH_FILES;
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme !== "file" || remainingFiles <= 0) continue;
    const found = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, "**/*"), SEARCH_EXCLUDE, remainingFiles);
    candidates.push(...found);
    remainingFiles = Math.max(0, MAX_SEARCH_FILES - candidates.length);
  }

  const matches: SearchMatch[] = [];
  const seen = new Set<string>();
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
    const fileMatches = findLiteralMatches(file, content, query, maxResults - matches.length);
    matches.push(...fileMatches);
    if (matches.length >= maxResults) return { query, matches, filesScanned, truncated: true };
  }
  return { query, matches, filesScanned, truncated: candidates.length >= MAX_SEARCH_FILES };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    switch (name) {
      case "get_workspace": {
        const roots = await workspaceRoots();
        return toolResult({
          vscodeConnected: true,
          workspaceFolders: roots,
          activeFile: await activeWorkspaceFile(roots),
        });
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
        const range = selectLineRange(
          content,
          typeof args.startLine === "number" ? args.startLine : args.startLine === undefined ? undefined : Number.NaN,
          typeof args.endLine === "number" ? args.endLine : args.endLine === undefined ? undefined : Number.NaN,
        );
        return toolResult({ path: file, ...range });
      }
      case "search_workspace": {
        if (typeof args.query !== "string" || args.query.length === 0 || args.query.length > 500) {
          return toolResult("query must contain 1 to 500 characters.", true);
        }
        if (args.maxResults !== undefined && (typeof args.maxResults !== "number" || !Number.isInteger(args.maxResults) || args.maxResults < 1 || args.maxResults > MAX_SEARCH_RESULTS)) {
          return toolResult(`maxResults must be an integer from 1 to ${MAX_SEARCH_RESULTS}.`, true);
        }
        const maxResults = typeof args.maxResults === "number" ? args.maxResults : 30;
        return toolResult(await searchWorkspace(args.query, maxResults));
      }
      default:
        return toolResult(`Unknown tool: ${name}`, true);
    }
  } catch (error) {
    return toolResult(error instanceof Error ? error.message : "Tool execution failed.", true);
  }
}

export async function handleMcpRequest(request: CloudMcpRequest): Promise<CloudMcpResponse> {
  return handleMcpRequestCore(request, callTool);
}
