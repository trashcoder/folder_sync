(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SyncLock = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const owners = new WeakSet();

  async function runExclusive(state, operation) {
    if (owners.has(state) || state.running || state.mutating) return { started: false };

    // This assignment happens before operation is invoked or awaited, so a
    // competing caller cannot pass the check above in the same event loop.
    owners.add(state);
    state.running = true;
    try {
      return { started: true, value: await operation() };
    } finally {
      owners.delete(state);
      state.running = false;
    }
  }

  async function runMutationExclusive(state, operation) {
    if (owners.has(state) || state.running || state.mutating) return { started: false };

    // Block sync starts before the mutation reaches its first asynchronous
    // storage operation. This closes the check-then-write race in message
    // handlers for editing and deleting configurations.
    state.mutating = true;
    try {
      return { started: true, value: await operation() };
    } finally {
      state.mutating = false;
    }
  }

  return { runExclusive, runMutationExclusive };
});
