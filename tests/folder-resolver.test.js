const test = require("node:test");
const assert = require("node:assert/strict");
const { descriptor, normalizeSpecialUse, resolveFolder } = require("../folder-resolver.js");

test("normalizes and persists special-use values deterministically", () => {
  assert.deepEqual(normalizeSpecialUse(["trash", "inbox", "trash", ""]), ["inbox", "trash"]);
  assert.deepEqual(descriptor({ id: "normal", name: "Normal", path: "/Normal" }), {
    id: "normal",
    name: "Normal",
    path: "/Normal",
    specialUse: [],
  });
});

test("resolves a persisted path to the current session id", () => {
  const result = resolveFolder(
    { id: "old", name: "Archive", path: "/Archive", specialUse: [] },
    [{ id: "new", name: "Archive", path: "/Archive", specialUse: [], canAddMessages: true }],
  );
  assert.equal(result.folder.id, "new");
  assert.equal(result.folder.canAddMessages, true);
  assert.equal(result.matchedBy, "path");
});

test("resolves a moved folder by unique persisted characteristics", () => {
  const result = resolveFolder(
    { id: "old", name: "Archive", path: "/Old/Archive", specialUse: [] },
    [{ id: "new", name: "Archive", path: "/New/Archive", specialUse: [] }],
  );
  assert.equal(result.folder.path, "/New/Archive");
  assert.equal(result.matchedBy, "characteristics");
});

test("uses special-use semantics to resolve a moved folder", () => {
  const result = resolveFolder(
    { id: "old", name: "Mail", path: "/Old/Mail", specialUse: ["sent"] },
    [
      { id: "normal", name: "Mail", path: "/Projects/Mail", specialUse: [] },
      { id: "sent", name: "Mail", path: "/System/Mail", specialUse: ["sent"] },
    ],
  );
  assert.equal(result.folder.id, "sent");
  assert.deepEqual(result.folder.specialUse, ["sent"]);
  assert.equal(result.matchedBy, "characteristics");
});

test("compares multiple special-use values independent of API order", () => {
  const result = resolveFolder(
    { name: "Combined", path: "/Old/Combined", specialUse: ["trash", "inbox"] },
    [{ id: "combined", name: "Combined", path: "/Combined", specialUse: ["inbox", "trash"] }],
  );
  assert.equal(result.folder.id, "combined");
  assert.deepEqual(result.folder.specialUse, ["inbox", "trash"]);
});

test("keeps path as the primary criterion even when special-use changed", () => {
  const result = resolveFolder(
    { id: "old", name: "Mail", path: "/Mail", specialUse: ["sent"] },
    [{ id: "current", name: "Mail", path: "/Mail", specialUse: [] }],
  );
  assert.equal(result.folder.id, "current");
  assert.equal(result.matchedBy, "path");
});

test("resolves a legacy type descriptor against specialUse", () => {
  const result = resolveFolder(
    { id: "old", name: "Inbox", path: "/Old/Inbox", type: "inbox" },
    [{ id: "current", name: "Inbox", path: "/Inbox", specialUse: ["inbox"] }],
  );
  assert.equal(result.folder.id, "current");
});

test("resolves a legacy descriptor without semantic folder metadata", () => {
  const result = resolveFolder(
    { id: "old", name: "Normal", path: "/Old/Normal" },
    [{ id: "current", name: "Normal", path: "/Normal", specialUse: [] }],
  );
  assert.equal(result.folder.id, "current");
});

test("rejects a missing folder", () => {
  assert.deepEqual(resolveFolder({ name: "Gone", path: "/Gone" }, []), { error: "not-found" });
});

test("preserves a non-writable capability on the resolved runtime folder", () => {
  const result = resolveFolder(
    { id: "old", name: "Read only", path: "/Read only", specialUse: [] },
    [{ id: "new", name: "Read only", path: "/Read only", specialUse: [], canAddMessages: false }],
  );
  assert.equal(result.folder.canAddMessages, false);
});

test("rejects an ambiguous fallback instead of choosing silently", () => {
  const result = resolveFolder(
    { id: "old", name: "Archive", path: "/Old/Archive", specialUse: [] },
    [
      { id: "one", name: "Archive", path: "/One/Archive", specialUse: [] },
      { id: "two", name: "Archive", path: "/Two/Archive", specialUse: [] },
    ],
  );
  assert.deepEqual(result, { error: "ambiguous" });
});
