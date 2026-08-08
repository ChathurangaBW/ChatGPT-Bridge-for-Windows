import assert from "node:assert/strict";
import test from "node:test";
import { EditorStateStore } from "../src/stateStore.js";
import type { EditorSnapshot } from "../src/types.js";

const snapshot: EditorSnapshot = {
  type: "editor_snapshot",
  workspaceFolders: ["C:\\workspace"],
  activeFile: "C:\\workspace\\index.ts",
  languageId: "typescript",
  dirty: true,
  content: "const value = 1;",
  contentTruncated: false,
  selection: null,
  diagnostics: [],
  diagnosticsTruncated: false,
  capturedAt: "2026-08-08T00:00:00.000Z",
};

test("EditorStateStore isolates multiple VS Code sessions and falls back to a connected snapshot", () => {
  const store = new EditorStateStore();
  assert.equal(store.isVscodeConnected(), false);
  assert.equal(store.getSnapshot(), null);

  store.connected("window-a");
  store.connected("window-b");
  store.update("window-a", snapshot);
  assert.deepEqual(store.getSnapshot(), snapshot);

  const windowB = {
    ...snapshot,
    activeFile: "C:\\workspace-b\\index.ts",
    content: "const value = 2;",
  };
  store.update("window-b", windowB);
  assert.deepEqual(store.getSnapshot(), windowB);

  store.disconnected("window-b");
  assert.equal(store.isVscodeConnected(), true);
  assert.deepEqual(store.getSnapshot(), snapshot);

  store.disconnected("window-a");
  store.disconnected("window-a");
  assert.equal(store.isVscodeConnected(), false);
  assert.equal(store.getSnapshot(), null);
  assert.throws(() => store.update("missing", snapshot), /disconnected/i);
});
