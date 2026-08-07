import { createServer, type Server as HttpServer } from "node:http";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from "@modelcontextprotocol/node";
import * as z from "zod/v4";
import type { EditorStateStore } from "./stateStore.js";
import { readWorkspaceTextFile, searchWorkspace } from "./workspace.js";

function result(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

function requireSnapshot(store: EditorStateStore) {
  if (!store.isVscodeConnected()) {
    throw new Error("VS Code is not currently connected to the local ChatGPT Bridge service.");
  }

  const snapshot = store.getSnapshot();
  if (!snapshot) {
    throw new Error("No editor snapshot is available. Start VS Code with the ChatGPT Bridge extension enabled.");
  }
  return snapshot;
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
      const snapshot = store.getSnapshot();
      return result({
        vscodeConnected: store.isVscodeConnected(),
        workspaceFolders: snapshot?.workspaceFolders ?? [],
        activeFile: snapshot?.activeFile ?? null,
        capturedAt: snapshot?.capturedAt ?? null,
      });
    },
  );

  server.registerTool(
    "get_active_editor",
    {
      title: "Get active VS Code editor",
      description: "Use this when you need the active VS Code file and its live buffer, including unsaved text.",
      annotations: readOnly,
    },
    async () => {
      const snapshot = requireSnapshot(store);
      return result({
        activeFile: snapshot.activeFile,
        languageId: snapshot.languageId,
        dirty: snapshot.dirty,
        content: snapshot.content,
        contentTruncated: snapshot.contentTruncated,
        capturedAt: snapshot.capturedAt,
      });
    },
  );

  server.registerTool(
    "get_selection",
    {
      title: "Get VS Code selection",
      description: "Use this when you need the text and range currently selected in the active VS Code editor.",
      annotations: readOnly,
    },
    async () => {
      const snapshot = requireSnapshot(store);
      return result({ activeFile: snapshot.activeFile, selection: snapshot.selection, capturedAt: snapshot.capturedAt });
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
      description: "Use this when you need to read an existing text file inside the currently open VS Code workspace.",
      inputSchema: z.object({
        path: z.string().min(1).describe("Absolute workspace path or a path relative to the first workspace folder."),
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
      const end = endLine ?? lines.length;
      if (end < start) throw new Error("endLine must be greater than or equal to startLine.");
      const content = lines.slice(start - 1, end).join("\n");
      return result({ path: file.path, startLine: start, endLine: Math.min(end, lines.length), content });
    },
  );

  server.registerTool(
    "search_workspace",
    {
      title: "Search VS Code workspace",
      description: "Use this when you need a literal case-insensitive text search across files in the open VS Code workspace.",
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
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);

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

    if (!validateHost(req, res) || !validateOrigin(req, res)) return;
    void nodeHandler(req, res);
  });

  server.listen(options.port, "127.0.0.1");
  return { server, closeMcp: () => handler.close() };
}
