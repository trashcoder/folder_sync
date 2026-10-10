(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.FolderResolver = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function normalizeSpecialUse(specialUse) {
    const values = Array.isArray(specialUse) ? specialUse :
      (typeof specialUse === "string" ? [specialUse] : []);
    return [...new Set(values
      .filter((value) => typeof value === "string" && value.trim())
      .map((value) => value.trim()))].sort();
  }

  function descriptor(folder) {
    return {
      id: folder.id,
      name: folder.name,
      path: folder.path,
      specialUse: normalizeSpecialUse(folder.specialUse),
    };
  }

  function runtimeFolder(folder) {
    return { ...descriptor(folder), canAddMessages: folder.canAddMessages === true };
  }

  function resolveFolder(stored, folders) {
    if (!stored) return { error: "missing-reference" };
    const byPath = stored.path ? folders.filter((folder) => folder.path === stored.path) : [];
    if (byPath.length === 1) return { folder: runtimeFolder(byPath[0]), matchedBy: "path" };
    if (byPath.length > 1) return { error: "ambiguous" };

    // Names and special-use flags do not establish identity. A missing path
    // must be repaired explicitly or by a concrete rename/move event.
    return { error: "not-found" };
  }

  return { descriptor, normalizeSpecialUse, resolveFolder };
});
