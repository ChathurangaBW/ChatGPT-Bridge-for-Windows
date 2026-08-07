import * as vscode from "vscode";
import type { DiagnosticSnapshot, EditorSnapshot, PositionSnapshot } from "./protocol.js";

const MAX_BUFFER_CHARS = 1_000_000;
const MAX_SELECTION_CHARS = 200_000;
const MAX_DIAGNOSTICS = 500;

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
  if (typeof value === "string" || typeof value === "number") return value;
  return typeof value.value === "string" || typeof value.value === "number" ? value.value : String(value.value);
}

function collectDiagnostics(): { diagnostics: DiagnosticSnapshot[]; truncated: boolean } {
  const workspaceFolders = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];
  const diagnostics: DiagnosticSnapshot[] = [];

  const belongsToWorkspace = (file: string): boolean => {
    if (workspaceFolders.length === 0) return false;
    const normalized = process.platform === "win32" ? file.toLowerCase() : file;
    return workspaceFolders.some((root) => {
      const candidate = process.platform === "win32" ? root.toLowerCase() : root;
      return normalized === candidate || normalized.startsWith(`${candidate}\\`) || normalized.startsWith(`${candidate}/`);
    });
  };

  for (const [uri, fileDiagnostics] of vscode.languages.getDiagnostics()) {
    if (uri.scheme !== "file" || !belongsToWorkspace(uri.fsPath)) continue;
    for (const item of fileDiagnostics) {
      diagnostics.push({
        file: uri.fsPath,
        message: item.message,
        severity: severity(item.severity),
        source: item.source,
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

  const fullContent = editor.document.getText();
  const selectedText = editor.document.getText(editor.selection);

  return {
    type: "editor_snapshot",
    workspaceFolders,
    activeFile: editor.document.uri.fsPath,
    languageId: editor.document.languageId,
    dirty: editor.document.isDirty,
    content: fullContent.slice(0, MAX_BUFFER_CHARS),
    contentTruncated: fullContent.length > MAX_BUFFER_CHARS,
    selection: {
      text: selectedText.slice(0, MAX_SELECTION_CHARS),
      start: position(editor.selection.start),
      end: position(editor.selection.end),
      isEmpty: editor.selection.isEmpty,
      truncated: selectedText.length > MAX_SELECTION_CHARS,
    },
    diagnostics: diagnosticResult.diagnostics,
    diagnosticsTruncated: diagnosticResult.truncated,
    capturedAt: new Date().toISOString(),
  };
}
