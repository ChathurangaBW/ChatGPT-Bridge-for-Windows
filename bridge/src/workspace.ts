import { realpath, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { EditorSnapshot } from "./types.js";

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_SCANNED_FILES = 5_000;
const IGNORED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "out",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
]);

function normalizeForComparison(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isInside(child: string, parent: string): boolean {
  const normalizedChild = normalizeForComparison(child);
  const normalizedParent = normalizeForComparison(parent);
  return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}${path.sep}`);
}

export async function resolveWorkspaceFile(inputPath: string, snapshot: EditorSnapshot): Promise<string> {
  if (snapshot.workspaceFolders.length === 0) {
    throw new Error("No VS Code workspace is currently open.");
  }

  const realRoots = await Promise.all(snapshot.workspaceFolders.map((folder) => realpath(folder)));
  const candidate = path.isAbsolute(inputPath)
    ? inputPath
    : path.resolve(snapshot.workspaceFolders[0], inputPath);
  const realCandidate = await realpath(candidate);

  if (!realRoots.some((root) => isInside(realCandidate, root))) {
    throw new Error("Requested path is outside the open VS Code workspace.");
  }

  const info = await stat(realCandidate);
  if (!info.isFile()) throw new Error("Requested path is not a file.");
  if (info.size > MAX_FILE_BYTES) throw new Error(`File exceeds ${MAX_FILE_BYTES} byte read limit.`);

  return realCandidate;
}

export async function readWorkspaceTextFile(inputPath: string, snapshot: EditorSnapshot): Promise<{
  path: string;
  content: string;
}> {
  const resolved = await resolveWorkspaceFile(inputPath, snapshot);
  const buffer = await readFile(resolved);
  if (buffer.includes(0)) throw new Error("File appears to be binary.");
  return { path: resolved, content: buffer.toString("utf8") };
}

export interface SearchMatch {
  file: string;
  line: number;
  preview: string;
}

export async function searchWorkspace(
  query: string,
  snapshot: EditorSnapshot,
  maxResults: number,
): Promise<{ matches: SearchMatch[]; scannedFiles: number; truncated: boolean }> {
  if (snapshot.workspaceFolders.length === 0) {
    throw new Error("No VS Code workspace is currently open.");
  }

  const needle = query.toLocaleLowerCase();
  const matches: SearchMatch[] = [];
  let scannedFiles = 0;
  let truncated = false;

  const visit = async (directory: string): Promise<void> => {
    if (matches.length >= maxResults || scannedFiles >= MAX_SCANNED_FILES) {
      truncated = true;
      return;
    }

    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (matches.length >= maxResults || scannedFiles >= MAX_SCANNED_FILES) {
        truncated = true;
        return;
      }

      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) await visit(fullPath);
        continue;
      }

      if (!entry.isFile()) continue;
      scannedFiles += 1;

      try {
        const info = await stat(fullPath);
        if (info.size > MAX_FILE_BYTES) continue;
        const buffer = await readFile(fullPath);
        if (buffer.includes(0)) continue;
        const lines = buffer.toString("utf8").split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
          if (lines[index].toLocaleLowerCase().includes(needle)) {
            matches.push({ file: fullPath, line: index + 1, preview: lines[index].trim().slice(0, 500) });
            if (matches.length >= maxResults) {
              truncated = true;
              return;
            }
          }
        }
      } catch {
        // Ignore files that disappear or become unreadable during a search.
      }
    }
  };

  for (const root of snapshot.workspaceFolders) {
    await visit(root);
    if (truncated) break;
  }

  return { matches, scannedFiles, truncated };
}
