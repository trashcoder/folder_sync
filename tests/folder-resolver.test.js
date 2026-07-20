const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveFolder } = require("../folder-resolver.js");

test("resolves a persisted path to the current session id", () => {
  const result = resolveFolder(
    { id: "old", name: "Archive", path: "/Archive", type: null },
    [{ id: "new", name: "Archive", path: "/Archive", type: null, canAddMessages: true }],
  );
  assert.equal(result.folder.id, "new");
  assert.equal(result.folder.canAddMessages, true);
  assert.equal(result.matchedBy, "path");
});

test("resolves a moved folder by unique persisted characteristics", () => {
  const result = resolveFolder(
    { id: "old", name: "Archive", path: "/Old/Archive", type: null },
    [{ id: "new", name: "Archive", path: "/New/Archive", type: null }],
  );
  assert.equal(result.folder.path, "/New/Archive");
  assert.equal(result.matchedBy, "characteristics");
});

test("rejects a missing folder", () => {
  assert.deepEqual(resolveFolder({ name: "Gone", path: "/Gone" }, []), { error: "not-found" });
});

test("preserves a non-writable capability on the resolved runtime folder", () => {
  const result = resolveFolder(
    { id: "old", name: "Read only", path: "/Read only", type: null },
    [{ id: "new", name: "Read only", path: "/Read only", type: null, canAddMessages: false }],
  );
  assert.equal(result.folder.canAddMessages, false);
});

test("rejects an ambiguous fallback instead of choosing silently", () => {
  const result = resolveFolder(
    { id: "old", name: "Archive", path: "/Old/Archive", type: null },
    [
      { id: "one", name: "Archive", path: "/One/Archive", type: null },
      { id: "two", name: "Archive", path: "/Two/Archive", type: null },
    ],
  );
  assert.deepEqual(result, { error: "ambiguous" });
});
