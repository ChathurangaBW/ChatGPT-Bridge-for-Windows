import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MAX_DIAGNOSTIC_CODE_BYTES,
  MAX_FILE_BYTES,
  MAX_SELECTION_BYTES,
  SEARCH_EXCLUDE,
  canonicalWorkspaceFile,
  findLiteralMatches,
  readWorkspaceText,
  resolveWorkspacePath,
  sanitizeDiagnosticCode,
  selectLineRange,
  truncateUtf8,
} from "../src/workspaceSecurity.js";

test("VSIX UTF-8 bounds do not split surrogate pairs or exceed byte limits", () => {
  const selection = "😀".repeat(MAX_SELECTION_BYTES);
  const bounded = truncateUtf8(selection, MAX_SELECTION_BYTES);
  assert.equal(bounded.truncated, true);
  assert.ok(Buffer.byteLength(bounded.text, "utf8") <= MAX_SELECTION_BYTES);
  assert.doesNotMatch(bounded.text, /[\uD800-\uDBFF]$/);

  const code = sanitizeDiagnosticCode("界".repeat(1000));
  assert.equal(typeof code, "string");
  assert.ok(Buffer.byteLength(code as string, "utf8") <= MAX_DIAGNOSTIC_CODE_BYTES);
  assert.equal(sanitizeDiagnosticCode(42), 42);
});

test("VSIX canonical path boundary rejects traversal, outside files, symlink escapes, and ambiguous multi-root paths", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "bridge-vsix-security-"));
  try {
    const rootA = path.join(temp, "workspace-a");
    const rootB = path.join(temp, "workspace-b");
    const outside = path.join(temp, "outside");
    await Promise.all([mkdir(rootA), mkdir(rootB), mkdir(outside)]);
    await writeFile(path.join(rootA, "inside.txt"), "inside", "utf8");
    await writeFile(path.join(rootA, "shared.txt"), "a", "utf8");
    await writeFile(path.join(rootB, "shared.txt"), "b", "utf8");
    await writeFile(path.join(outside, "secret.txt"), "secret", "utf8");

    const roots = [await realpath(rootA), await realpath(rootB)];
    assert.equal(await canonicalWorkspaceFile(path.join(rootA, "inside.txt"), roots), await realpath(path.join(rootA, "inside.txt")));
    assert.equal(await canonicalWorkspaceFile(path.join(outside, "secret.txt"), roots), null);
    assert.equal(await resolveWorkspacePath("inside.txt", roots), await realpath(path.join(rootA, "inside.txt")));
    await assert.rejects(() => resolveWorkspacePath("../outside/secret.txt", roots), /not found|outside/i);
    await assert.rejects(() => resolveWorkspacePath(path.join(outside, "secret.txt"), roots), /outside/i);
    await assert.rejects(() => resolveWorkspacePath("shared.txt", roots), /ambiguous/i);
    await assert.rejects(() => resolveWorkspacePath("missing.txt", roots), /not found/i);

    const link = path.join(rootA, "outside-link");
    await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
    assert.equal(await canonicalWorkspaceFile(path.join(link, "secret.txt"), roots), null);
    await assert.rejects(() => resolveWorkspacePath(path.join("outside-link", "secret.txt"), roots), /not found|outside/i);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("VSIX workspace reader accepts bounded UTF-8 and rejects directories, NUL, invalid UTF-8, and oversized files", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "bridge-vsix-reader-"));
  try {
    const valid = path.join(temp, "valid.txt");
    const nul = path.join(temp, "nul.bin");
    const invalid = path.join(temp, "invalid.txt");
    const oversized = path.join(temp, "oversized.txt");
    await writeFile(valid, "hello\nworld", "utf8");
    await writeFile(nul, Buffer.from([0x41, 0x00, 0x42]));
    await writeFile(invalid, Buffer.from([0xc3, 0x28]));
    await writeFile(oversized, Buffer.alloc(MAX_FILE_BYTES + 1, 0x61));

    assert.equal(await readWorkspaceText(valid), "hello\nworld");
    await assert.rejects(() => readWorkspaceText(temp), /regular file/i);
    await assert.rejects(() => readWorkspaceText(nul), /binary-looking/i);
    await assert.rejects(() => readWorkspaceText(invalid), /valid UTF-8/i);
    await assert.rejects(() => readWorkspaceText(oversized), /read limit/i);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("VSIX read-file line ranges validate EOF and ordering", () => {
  const content = "one\ntwo\nthree";
  assert.deepEqual(selectLineRange(content, 1, 1), { startLine: 1, endLine: 1, content: "one" });
  assert.deepEqual(selectLineRange(content, 3), { startLine: 3, endLine: 3, content: "three" });
  assert.deepEqual(selectLineRange(content, 2, 99), { startLine: 2, endLine: 3, content: "two\nthree" });
  assert.throws(() => selectLineRange(content, 4), /exceeds/i);
  assert.throws(() => selectLineRange(content, 3, 2), /greater than or equal/i);
  assert.throws(() => selectLineRange(content, 0), /positive integer/i);
  assert.throws(() => selectLineRange(content, 1, 0), /positive integer/i);
});

test("VSIX search helper is literal, case-insensitive, bounded, and has all required exclusion directories", () => {
  const content = ["Alpha a+b[1]", "nothing", "alpha A+B[1]", "a+b[1] again"].join("\n");
  const literal = findLiteralMatches("file.txt", content, "a+b[1]", 10);
  assert.equal(literal.length, 3);
  assert.deepEqual(literal.map((match) => match.line), [1, 3, 4]);
  assert.equal(findLiteralMatches("file.txt", content, "A+B[1]", 2).length, 2);
  assert.equal(findLiteralMatches("file.txt", content, ".*", 10).length, 0);

  for (const directory of ["node_modules", ".git", "dist", "build", "out", "coverage", ".next", ".cache", "vendor"]) {
    assert.ok(SEARCH_EXCLUDE.includes(directory), `Missing search exclusion for ${directory}`);
  }
});
