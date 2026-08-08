import { createServer, type Server as HttpServer } from "node:http";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { EditorStateStore } from "./stateStore.js";
import { isWorkspacePath, readWorkspaceTextFile, searchWorkspace } from "./workspace.js";
import { toNodeHandler, validateLoopbackRequest } from "./nodeHttpAdapter.js";
import type { EditorSnapshot } from "./types.js";

function result(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

function requireSnapshot(store: EditorStateStore): EditorSnapshot {
  if (!store.isVscodeConnected()) {
    throw new Error("VS Code is not currently connected to the local ChatGPT Bridge service.");
  }

  const snapshot = store.getSnapshot();
  if (!snapshot) {
    throw new Error("No editor snapshot is available. Start VS Code with the ChatGPT Bridge extension enabled.");
  }
  return snapshot;
}

async function visibleActiveFile(snapshot: EditorSnapshot): Promise<string | null> {
  if (!snapshot.activeFile) return null;
  return (await isWorkspacePath(snapshot.activeFile, snapshot)) ? snapshot.activeFile : null;
}

function hiddenEditorResult(snapshot: EditorSnapshot) {
  return {
    activeFile: null,
    languageId: null,
    dirty: false,
    content: null,
    contentTruncated: false,
    restricted: snapshot.activeFile !== null,
    capturedAt: snapshot.capturedAt,
  };
}

function buildMcpServer(store: EditorStateStore): McpServer {
  const server = new McpServer({ name: "chatgpt-bridge-windows", version: "0.1.0" });
  const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;

  server.registerTool(
    "get_workspace",
    {
      title: "Get VS Code workspace",
      description: "Use this when you need the currently open VS Code workspace folders and bridge connection state.",
      annotations: readOnly,
    },
    async () => {
      const connected = store.isVscodeConnected();
      const snapshot = connected ? store.getSnapshot() : null;
      return result({
        vscodeConnected: connected,
        workspaceFolders: snapshot?.workspaceFolders ?? [],
        activeFile: snapshot ? await visibleActiveFile(snapshot) : null,
        capturedAt: snapshot?.capturedAt ?? null,
      });
    },
  );

  server.registerTool(
    "get_active_editor",
    {
      title: "Get active VS Code editor",
      description: "Use this when you need the active workspace file and its live buffer, including unsaved text. Files outside the open workspace are not exposed.",
      annotations: readOnly,
    },
    async () => {
      const snapshot = requireSnapshot(store);
      const activeFile = await visibleActiveFile(snapshot);
      if (!activeFile) return result(hiddenEditorResult(snapshot));
      return result({
        activeFile,
        languageId: snapshot.languageId,
        dirty: snapshot.dirty,
        content: snapshot.content,
        contentTruncated: snapshot.contentTruncated,
        restricted: false,
        capturedAt: snapshot.capturedAt,
      });
    },
  );

  server.registerTool(
    "get_selection",
    {
      title: "Get VS Code selection",
      description: "Use this when you need the text and range currently selected in the active workspace editor. Files outside the open workspace are not exposed.",
      annotations: readOnly,
    },
    async () => {
      const snapshot = requireSnapshot(store);
      const activeFile = await visibleActiveFile(snapshot);
      return result({
        activeFile,
        selection: activeFile ? snapshot.selection : null,
        restricted: !activeFile && snapshot.activeFile !== null,
        capturedAt: snapshot.capturedAt,
      });
    },
  );

  server.registerTool(
    "get_diagnostics",
    {
      title: "Get VS Code diagnostics",
      description: "Use this when you need current VS Code errors, warnings, information, or hints from the open workspace.",
      annotations: readOnly,
    },
    async () => {
      const snapshot = requireSnapshot(store);
      return result({
        diagnostics: snapshot.diagnostics,
        truncated: snapshot.diagnosticsTruncated,
        capturedAt: snapshot.capturedAt,
      });
    },
  );

  server.registerTool(
    "read_file",
    {
      title: "Read workspace file",
      description: "Use this when you need to read an existing UTF-8 text file inside an open VS Code workspace folder.",
      inputSchema: z.object({
        path: z.string().min(1).describe("Absolute workspace path, or a relative path that uniquely identifies a file across the open workspace folders."),
        startLine: z.number().int().positive().optional(),
        endLine: z.number().int().positive().optional(),
      }),
      annotations: readOnly,
    },
    async ({ path, startLine, endLine }) => {
      const snapshot = requireSnapshot(store);
      const file = await readWorkspaceTextFile(path, snapshot);
      const lines = file.content.split(/\r?\n/);
      const start = startLine ?? 1;
      if (start > lines.length) {
        throw new Error(`startLine ${start} exceeds the file length of ${lines.length} lines.`);
      }
      const end = endLine ?? lines.length;
      if (end < start) throw new Error("endLine must be greater than or equal to startLine.");
      const clampedEnd = Math.min(end, lines.length);
      const content = lines.slice(start - 1, clampedEnd).join("\n");
      return result({ path: file.path, startLine: start, endLine: clampedEnd, content });
    },
  );

  server.registerTool(
    "search_workspace",
    {
      title: "Search VS Code workspace",
      description: "Use this when you need a literal case-insensitive text search across UTF-8 files in the open VS Code workspace.",
      inputSchema: z.object({
        query: z.string().min(1).max(500),
        maxResults: z.number().int().min(1).max(100).default(30),
      }),
      annotations: readOnly,
    },
    async ({ query, maxResults }) => {
      const snapshot = requireSnapshot(store);
      return result(await searchWorkspace(query, snapshot, maxResults));
    },
  );

  return server;
}

export function startMcpHttpServer(options: { port: number; store: EditorStateStore }): {
  server: HttpServer;
  closeMcp: () => Promise<void>;
} {
  const handler = createMcpHandler(() => buildMcpServer(options.store), { responseMode: "json" });
  const nodeHandler = toNodeHandler(handler);

  const server = createServer((req, res) => {
    if (!validateLoopbackRequest(req, res)) return;

    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, vscodeConnected: options.store.isVscodeConnected() }));
      return;
    }

    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    void nodeHandler(req, res);
  });

  server.listen(options.port, "127.0.0.1");
  return { server, closeMcp: () => handler.close() };
}
