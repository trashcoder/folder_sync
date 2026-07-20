const test = require("node:test");
const assert = require("node:assert/strict");
const Store = require("../sync-state-store.js");

test("restores durable results and discards transient progress", () => {
  const restored = Store.restore({
    alpha: {
      running: false,
      startedAt: null,
      lastSync: "2026-07-20T10:00:00.000Z",
      lastResult: { copiedAtoB: 2 },
      error: "copy failed",
      progress: { completed: 1, total: 2 },
    },
  }, "interrupted");

  assert.equal(restored.cleaned, true);
  assert.deepEqual(restored.states.get("alpha"), {
    status: "failed",
    running: false,
    startedAt: null,
    lastSync: "2026-07-20T10:00:00.000Z",
    lastResult: { copiedAtoB: 2 },
    error: "copy failed",
    progress: null,
  });
});

test("cleans an orphaned running marker after background restart", () => {
  const restored = Store.restore({
    alpha: {
      running: true,
      status: "running",
      startedAt: "2026-07-20T10:00:00.000Z",
      lastSync: null,
      lastResult: null,
      error: null,
    },
  }, "interrupted");

  assert.equal(restored.cleaned, true);
  assert.equal(restored.states.get("alpha").running, false);
  assert.equal(restored.states.get("alpha").startedAt, null);
  assert.equal(restored.states.get("alpha").error, "interrupted");
});

test("serializes only durable state", () => {
  const states = new Map([["alpha", {
    running: true,
    startedAt: "2026-07-20T10:00:00.000Z",
    lastSync: null,
    lastResult: null,
    error: null,
    progress: { completed: 1, total: 2 },
  }]]);

  assert.deepEqual(Store.serialize(states), {
    alpha: {
      running: true,
      status: "running",
      startedAt: "2026-07-20T10:00:00.000Z",
      lastSync: null,
      lastResult: null,
      error: null,
    },
  });
});

test("marks a full success explicitly", () => {
  const state = Store.emptyState();
  Store.complete(state, { copiedAtoB: 2, copiedBtoA: 1, errors: [] }, null, "2026-07-20T11:00:00.000Z");
  assert.equal(state.status, Store.STATUS.SUCCESS);
  assert.equal(state.error, null);
  assert.equal(state.lastSync, "2026-07-20T11:00:00.000Z");
});

test("marks batch errors as a visible partial failure", () => {
  const state = Store.emptyState();
  Store.complete(state, { copiedAtoB: 2, copiedBtoA: 0, errors: ["A→B batch 50: copy failed"] }, null, "2026-07-20T11:00:00.000Z");
  assert.equal(state.status, Store.STATUS.PARTIAL_FAILURE);
  assert.equal(state.error, "A→B batch 50: copy failed");
  assert.equal(state.lastResult.errors.length, 1);
});

test("marks fatal errors as failed", () => {
  const state = Store.emptyState();
  Store.complete(state, { copiedAtoB: 0, copiedBtoA: 0, errors: ["folder unavailable"], fatal: true }, "folder unavailable", "2026-07-20T11:00:00.000Z");
  assert.equal(state.status, Store.STATUS.FAILED);
  assert.equal(state.error, "folder unavailable");
  assert.equal(state.running, false);
});
