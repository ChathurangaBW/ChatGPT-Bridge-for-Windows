import path from "node:path";
import * as vscode from "vscode";
import type { DiagnosticSnapshot, EditorSnapshot, PositionSnapshot } from "./protocol.js";

const MAX_BUFFER_BYTES = 1024 * 1024;
const MAX_SELECTION_BYTES = 200 * 1024;
const MAX_DIAGNOSTICS = 500;
const MAX_DIAGNOSTIC_MESSAGE_BYTES = 4 * 1024;
const MAX_DIAGNOSTIC_SOURCE_BYTES = 256;
const MAX_DIAGNOSTIC_CODE_BYTES = 512;

function truncateUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return { text: value, truncated: false };

  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, mid), "utf8") <= maxBytes) low = mid;
    else high = mid - 1;
  }

  let end = low;
  if (end > 0) {
    const last = value.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  }
  return { text: value.slice(0, end), truncated: true };
}

function position(value: vscode.Position): PositionSnapshot {
  return { line: value.line, character: value.character };
}

function severity(value: vscode.DiagnosticSeverity): DiagnosticSnapshot["severity"] {
  switch (value) {
    case vscode.DiagnosticSeverity.Error:
      return "error";
    case vscode.DiagnosticSeverity.Warning:
      return "warning";
    case vscode.DiagnosticSeverity.Information:
      return "information";
    default:
      return "hint";
  }
}

function diagnosticCode(value: vscode.Diagnostic["code"]): string | number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") return value;
  if (typeof value === "string") return truncateUtf8(value, MAX_DIAGNOSTIC_CODE_BYTES).text;
  const code = value.value;
  if (typeof code === "number") return code;
  return truncateUtf8(String(code), MAX_DIAGNOSTIC_CODE_BYTES).text;
}

function isInsideWorkspace(file: string, workspaceFolders: string[]): boolean {
  const target = path.resolve(file);
  return workspaceFolders.some((root) => {
    const relative = path.relative(path.resolve(root), target);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
}

function collectDiagnostics(): { diagnostics: DiagnosticSnapshot[]; truncated: boolean } {
  const workspaceFolders = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];
  const diagnostics: DiagnosticSnapshot[] = [];

  for (const [uri, fileDiagnostics] of vscode.languages.getDiagnostics()) {
    if (uri.scheme !== "file" || !isInsideWorkspace(uri.fsPath, workspaceFolders)) continue;
    for (const item of fileDiagnostics) {
      const message = truncateUtf8(item.message, MAX_DIAGNOSTIC_MESSAGE_BYTES).text;
      const source = item.source
        ? truncateUtf8(item.source, MAX_DIAGNOSTIC_SOURCE_BYTES).text
        : undefined;

      diagnostics.push({
        file: uri.fsPath,
        message,
        severity: severity(item.severity),
        source,
        code: diagnosticCode(item.code),
        range: { start: position(item.range.start), end: position(item.range.end) },
      });
      if (diagnostics.length >= MAX_DIAGNOSTICS) return { diagnostics, truncated: true };
    }
  }

  return { diagnostics, truncated: false };
}

export function captureEditorSnapshot(): EditorSnapshot {
  const editor = vscode.window.activeTextEditor;
  const workspaceFolders = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];
  const diagnosticResult = collectDiagnostics();

  if (!editor || editor.document.uri.scheme !== "file") {
    return {
      type: "editor_snapshot",
      workspaceFolders,
      activeFile: null,
      languageId: null,
      dirty: false,
      content: null,
      contentTruncated: false,
      selection: null,
      diagnostics: diagnosticResult.diagnostics,
      diagnosticsTruncated: diagnosticResult.truncated,
      capturedAt: new Date().toISOString(),
    };
  }

  const content = truncateUtf8(editor.document.getText(), MAX_BUFFER_BYTES);
  const selectionText = truncateUtf8(editor.document.getText(editor.selection), MAX_SELECTION_BYTES);

  return {
    type: "editor_snapshot",
    workspaceFolders,
    activeFile: editor.document.uri.fsPath,
    languageId: editor.document.languageId,
    dirty: editor.document.isDirty,
    content: content.text,
    contentTruncated: content.truncated,
    selection: {
      text: selectionText.text,
      start: position(editor.selection.start),
      end: position(editor.selection.end),
      isEmpty: editor.selection.isEmpty,
      truncated: selectionText.truncated,
    },
    diagnostics: diagnosticResult.diagnostics,
    diagnosticsTruncated: diagnosticResult.truncated,
    capturedAt: new Date().toISOString(),
  };
}
