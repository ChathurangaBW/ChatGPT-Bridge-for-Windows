import { realpath, readFile, stat } from "node:fs/promises";
import path from "node:path";

export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_SELECTION_BYTES = 200 * 1024;
export const MAX_DIAGNOSTICS = 500;
export const MAX_DIAGNOSTIC_MESSAGE_BYTES = 4 * 1024;
export const MAX_DIAGNOSTIC_SOURCE_BYTES = 256;
export const MAX_DIAGNOSTIC_CODE_BYTES = 512;
export const MAX_SEARCH_FILES = 5000;
export const MAX_SEARCH_RESULTS = 100;
export const SEARCH_EXCLUDE = "**/{node_modules,.git,dist,build,out,coverage,.next,.cache,vendor}/**";

export function truncateUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  if (maxBytes < 0) throw new Error("maxBytes must be non-negative.");
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

export function normalizeFsPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function canonicalWorkspaceFile(file: string, roots: string[]): Promise<string | null> {
  try {
    const canonical = await realpath(file);
    const targetKey = normalizeFsPath(canonical);
    return roots.some((root) => isInside(normalizeFsPath(root), targetKey)) ? canonical : null;
  } catch {
    return null;
  }
}

export async function resolveWorkspacePath(input: string, roots: string[]): Promise<string> {
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

export async function readWorkspaceText(file: string): Promise<string> {
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

export function sanitizeDiagnosticCode(value: unknown): string | number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") return value;
  return truncateUtf8(String(value), MAX_DIAGNOSTIC_CODE_BYTES).text;
}
