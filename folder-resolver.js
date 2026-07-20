(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.FolderResolver = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function descriptor(folder) {
    return { id: folder.id, name: folder.name, path: folder.path, type: folder.type || null };
  }

  function resolveFolder(stored, folders) {
    if (!stored) return { error: "missing-reference" };
    const byPath = stored.path ? folders.filter((folder) => folder.path === stored.path) : [];
    if (byPath.length === 1) return { folder: descriptor(byPath[0]), matchedBy: "path" };
    if (byPath.length > 1) return { error: "ambiguous" };

    let candidates = folders.filter((folder) => folder.name === stored.name);
    if (stored.type) candidates = candidates.filter((folder) => (folder.type || null) === stored.type);
    if (candidates.length === 1) return { folder: descriptor(candidates[0]), matchedBy: "characteristics" };
    if (candidates.length > 1) return { error: "ambiguous" };
    return { error: "not-found" };
  }

  return { descriptor, resolveFolder };
});
