(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SyncStateStore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const STORAGE_KEY = "syncStates";

  function emptyState() {
    return { running: false, startedAt: null, lastSync: null, lastResult: null, error: null, progress: null };
  }

  function durableState(state) {
    return {
      running: !!state.running,
      startedAt: state.startedAt || null,
      lastSync: state.lastSync || null,
      lastResult: state.lastResult || null,
      error: state.error || null,
    };
  }

  function restore(snapshot, interruptedError) {
    const states = new Map();
    let cleaned = false;
    for (const [syncId, saved] of Object.entries(snapshot || {})) {
      const state = { ...emptyState(), ...saved, progress: null };
      if (state.running) {
        // A newly loaded MV3 background page cannot own work from its previous
        // instance, so its persisted marker is necessarily orphaned.
        state.running = false;
        state.startedAt = null;
        state.error = interruptedError;
        cleaned = true;
      } else if (state.startedAt) {
        state.startedAt = null;
        cleaned = true;
      }
      states.set(syncId, state);
    }
    return { states, cleaned };
  }

  function serialize(states) {
    const result = {};
    for (const [syncId, state] of states) result[syncId] = durableState(state);
    return result;
  }

  return { STORAGE_KEY, emptyState, restore, serialize };
});
