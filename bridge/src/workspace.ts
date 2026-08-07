import { realpath, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import type { EditorSnapshot } from "./types.js";

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_SCANNED_FILES = 5_000;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".cache",
  ".next",
  ".turbo",
  ".venv",
  "node_modules",
  "vendor",
  "venv",
  "dist",
  "out",
  "build",
  "coverage",
  "target",
  "bin",
  "obj",
]);

function normalizeForComparison(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isInside(child: string, parent: string): boolean {
  const normalizedChild = normalizeForComparison(child);
  const normalizedParent = normalizeForComparison(parent);
  const relative = path.relative(normalizedParent, normalizedChild);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function decodeText(buffer: Buffer): string {
  if (buffer.includes(0)) throw new Error("File appears to be binary.");
  try {
    return UTF8_DECODER.decode(buffer);
  } catch {
    throw new Error("File is not valid UTF-8 text.");
  }
}

async function canonicalWorkspaceRoots(snapshot: EditorSnapshot): Promise<string[]> {
  if (snapshot.workspaceFolders.length === 0) {
    throw new Error("No VS Code workspace is currently open.");
  }

  const roots = await Promise.all(snapshot.workspaceFolders.map((folder) => realpath(folder)));
  const unique = new Map<string, string>();
  for (const root of roots) unique.set(normalizeForComparison(root), root);
  return [...unique.values()];
}

async function resolveRelativeWorkspacePath(inputPath: string, realRoots: string[]): Promise<string> {
  const candidates: string[] = [];
  for (const root of realRoots) {
    try {
      const candidate = await realpath(path.resolve(root, inputPath));
      if (isInside(candidate, root)) candidates.push(candidate);
    } catch {
      // Try the next workspace root.
    }
  }

  const unique = [...new Map(candidates.map((candidate) => [normalizeForComparison(candidate), candidate])).values()];
  if (unique.length === 0) throw new Error("Requested path was not found in the open VS Code workspace.");
  if (unique.length > 1) {
    throw new Error("Relative path is ambiguous across workspace roots. Use an absolute workspace path.");
  }
  return unique[0];
}

export async function resolveWorkspacePath(inputPath: string, snapshot: EditorSnapshot): Promise<string> {
  const realRoots = await canonicalWorkspaceRoots(snapshot);
  const realCandidate = path.isAbsolute(inputPath)
    ? await realpath(inputPath)
    : await resolveRelativeWorkspacePath(inputPath, realRoots);

  if (!realRoots.some((root) => isInside(realCandidate, root))) {
    throw new Error("Requested path is outside the open VS Code workspace.");
  }
  return realCandidate;
}

export async function isWorkspacePath(inputPath: string, snapshot: EditorSnapshot): Promise<boolean> {
  try {
    await resolveWorkspacePath(inputPath, snapshot);
    return true;
  } catch {
    return false;
  }
}

export async function resolveWorkspaceFile(inputPath: string, snapshot: EditorSnapshot): Promise<string> {
  const realCandidate = await resolveWorkspacePath(inputPath, snapshot);
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
  return { path: resolved, content: decodeText(buffer) };
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
  const realRoots = await canonicalWorkspaceRoots(snapshot);
  const needle = query.toLowerCase();
  const matches: SearchMatch[] = [];
  const visitedFiles = new Set<string>();
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
        if (!IGNORED_DIRECTORIES.has(entry.name.toLowerCase())) await visit(fullPath);
        continue;
      }

      if (!entry.isFile()) continue;
      const normalizedFile = normalizeForComparison(fullPath);
      if (visitedFiles.has(normalizedFile)) continue;
      visitedFiles.add(normalizedFile);
      scannedFiles += 1;

      try {
        const info = await stat(fullPath);
        if (info.size > MAX_FILE_BYTES) continue;
        const buffer = await readFile(fullPath);
        const lines = decodeText(buffer).split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
          if (lines[index].toLowerCase().includes(needle)) {
            matches.push({ file: fullPath, line: index + 1, preview: lines[index].trim().slice(0, 500) });
            if (matches.length >= maxResults) {
              truncated = true;
              return;
            }
          }
        }
      } catch {
        // Ignore files that disappear, become unreadable, or are not UTF-8 text during a search.
      }
    }
  };

  for (const root of realRoots) {
    await visit(root);
    if (truncated) break;
  }

  return { matches, scannedFiles, truncated };
}
