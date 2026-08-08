import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { EditorSnapshot } from "../src/types.js";
import {
  isWorkspacePath,
  readWorkspaceTextFile,
  resolveWorkspaceFile,
  resolveWorkspacePath,
  searchWorkspace,
} from "../src/workspace.js";

function snapshot(workspaceFolders: string[]): EditorSnapshot {
  return {
    type: "editor_snapshot",
    workspaceFolders,
    activeFile: null,
    languageId: null,
    dirty: false,
    content: null,
    contentTruncated: false,
    selection: null,
    diagnostics: [],
    diagnosticsTruncated: false,
    capturedAt: new Date().toISOString(),
  };
}

test("workspace paths stay inside canonical roots and support unique multi-root relative paths", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "chatgpt-bridge-workspace-"));
  const rootA = path.join(root, "a");
  const rootB = path.join(root, "b");
  const outside = path.join(root, "outside.txt");
  await mkdir(rootA);
  await mkdir(rootB);
  await writeFile(path.join(rootA, "only-a.txt"), "alpha\n", "utf8");
  await writeFile(path.join(rootA, "same.txt"), "from a\n", "utf8");
  await writeFile(path.join(rootB, "same.txt"), "from b\n", "utf8");
  await writeFile(outside, "outside\n", "utf8");
  t.after(() => rm(root, { recursive: true, force: true }));

  const state = snapshot([rootA, rootB]);
  const unique = await readWorkspaceTextFile("only-a.txt", state);
  assert.equal(unique.content, "alpha\n");
  assert.equal(await resolveWorkspaceFile(unique.path, state), unique.path);
  assert.equal(await resolveWorkspacePath(unique.path, state), unique.path);
  assert.equal(await isWorkspacePath(unique.path, state), true);
  assert.equal(await isWorkspacePath(outside, state), false);

  await assert.rejects(() => resolveWorkspaceFile("same.txt", state), /ambiguous/i);
  await assert.rejects(() => resolveWorkspaceFile(outside, state), /outside/i);
});

test("workspace search is literal, bounded, and skips dependency/build directories", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "chatgpt-bridge-search-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "node_modules", "hidden"), { recursive: true });
  await mkdir(path.join(root, "target"), { recursive: true });
  await writeFile(path.join(root, "src", "visible.ts"), "const token = 'Needle';\n", "utf8");
  await writeFile(path.join(root, "node_modules", "hidden", "ignored.js"), "needle\n", "utf8");
  await writeFile(path.join(root, "target", "ignored.txt"), "needle\n", "utf8");
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = await searchWorkspace("needle", snapshot([root]), 10);
  assert.equal(result.matches.length, 1);
  assert.equal(path.basename(result.matches[0].file), "visible.ts");
  assert.equal(result.matches[0].line, 1);
  assert.equal(result.truncated, false);
});

test("workspace reader rejects binary-looking, invalid UTF-8, and oversized files", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "chatgpt-bridge-read-"));
  const binary = path.join(root, "binary.bin");
  const invalidUtf8 = path.join(root, "invalid.txt");
  const large = path.join(root, "large.txt");
  await writeFile(binary, Buffer.from([65, 0, 66]));
  await writeFile(invalidUtf8, Buffer.from([0xff, 0xfe, 0xfd]));
  await writeFile(large, Buffer.alloc(1024 * 1024 + 1, 65));
  t.after(() => rm(root, { recursive: true, force: true }));

  const state = snapshot([root]);
  await assert.rejects(() => readWorkspaceTextFile(binary, state), /binary/i);
  await assert.rejects(() => readWorkspaceTextFile(invalidUtf8, state), /UTF-8/i);
  await assert.rejects(() => readWorkspaceTextFile(large, state), /exceeds/i);
});
