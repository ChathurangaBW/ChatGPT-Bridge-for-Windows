export interface PositionSnapshot {
  line: number;
  character: number;
}

export interface SelectionSnapshot {
  text: string;
  start: PositionSnapshot;
  end: PositionSnapshot;
  isEmpty: boolean;
  truncated: boolean;
}

export interface DiagnosticSnapshot {
  file: string;
  message: string;
  severity: "error" | "warning" | "information" | "hint";
  source?: string;
  code?: string | number;
  range: {
    start: PositionSnapshot;
    end: PositionSnapshot;
  };
}

export interface EditorSnapshot {
  type: "editor_snapshot";
  workspaceFolders: string[];
  activeFile: string | null;
  languageId: string | null;
  dirty: boolean;
  content: string | null;
  contentTruncated: boolean;
  selection: SelectionSnapshot | null;
  diagnostics: DiagnosticSnapshot[];
  diagnosticsTruncated: boolean;
  capturedAt: string;
}

export interface BridgeHello {
  type: "hello";
  token: string;
  client: "vscode";
  version: string;
}
