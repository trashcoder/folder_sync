(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SyncLock = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  async function runExclusive(state, operation) {
    if (state.running) return { started: false };

    // This assignment happens before operation is invoked or awaited, so a
    // competing caller cannot pass the check above in the same event loop.
    state.running = true;
    try {
      return { started: true, value: await operation() };
    } finally {
      state.running = false;
    }
  }

  return { runExclusive };
});
