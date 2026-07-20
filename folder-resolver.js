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

    let candidates = folders.filter((folder) => folder.name === stored.name);
    let storedSpecialUse = null;
    if (Object.prototype.hasOwnProperty.call(stored, "specialUse")) {
      storedSpecialUse = normalizeSpecialUse(stored.specialUse);
    } else if (stored.type) {
      // Compatibility with descriptors persisted by the Manifest V2 API.
      storedSpecialUse = normalizeSpecialUse(stored.type);
    }
    if (storedSpecialUse) {
      candidates = candidates.filter((folder) => {
        const currentSpecialUse = normalizeSpecialUse(folder.specialUse);
        return currentSpecialUse.length === storedSpecialUse.length &&
          currentSpecialUse.every((value, index) => value === storedSpecialUse[index]);
      });
    }
    if (candidates.length === 1) return { folder: runtimeFolder(candidates[0]), matchedBy: "characteristics" };
    if (candidates.length > 1) return { error: "ambiguous" };
    return { error: "not-found" };
  }

  return { descriptor, normalizeSpecialUse, resolveFolder };
});
