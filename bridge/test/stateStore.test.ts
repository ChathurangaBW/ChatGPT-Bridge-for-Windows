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

test("EditorStateStore tracks snapshots and connection count safely", () => {
  const store = new EditorStateStore();
  assert.equal(store.isVscodeConnected(), false);
  assert.equal(store.getSnapshot(), null);

  store.connected();
  store.connected();
  store.update(snapshot);
  assert.equal(store.isVscodeConnected(), true);
  assert.deepEqual(store.getSnapshot(), snapshot);

  store.disconnected();
  assert.equal(store.isVscodeConnected(), true);
  store.disconnected();
  store.disconnected();
  assert.equal(store.isVscodeConnected(), false);
});
