(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SyncStateStore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const STORAGE_KEY = "syncStates";
  const STATUS = Object.freeze({
    IDLE: "idle",
    RUNNING: "running",
    SUCCESS: "success",
    PARTIAL_FAILURE: "partialFailure",
    FAILED: "failed",
  });

  function emptyState() {
    return { status: STATUS.IDLE, running: false, startedAt: null, lastSync: null, lastResult: null, error: null, progress: null };
  }

  function start(state, startedAt) {
    state.status = STATUS.RUNNING;
    state.running = true;
    state.startedAt = startedAt;
    state.error = null;
  }

  function complete(state, result, fatalError, completedAt) {
    const errors = Array.isArray(result?.errors) ? result.errors : [];
    state.status = fatalError ? STATUS.FAILED : (errors.length ? STATUS.PARTIAL_FAILURE : STATUS.SUCCESS);
    state.running = false;
    state.startedAt = null;
    state.lastSync = completedAt;
    state.lastResult = result;
    state.error = fatalError || (errors.length ? errors[0] : null);
    state.progress = null;
  }

  function durableState(state) {
    return {
      running: !!state.running,
      status: state.status || (state.running ? STATUS.RUNNING : STATUS.IDLE),
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
      if (!saved.status) {
        const resultErrors = Array.isArray(saved.lastResult?.errors) ? saved.lastResult.errors : [];
        state.status = saved.running ? STATUS.RUNNING :
          (saved.error ? STATUS.FAILED :
            (saved.lastResult ? (resultErrors.length ? STATUS.PARTIAL_FAILURE : STATUS.SUCCESS) : STATUS.IDLE));
        cleaned = true;
      }
      if (state.running) {
        // A newly loaded MV3 background page cannot own work from its previous
        // instance, so its persisted marker is necessarily orphaned.
        state.running = false;
        state.startedAt = null;
        state.error = interruptedError;
        state.status = STATUS.FAILED;
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

  return { STORAGE_KEY, STATUS, emptyState, start, complete, restore, serialize };
});
