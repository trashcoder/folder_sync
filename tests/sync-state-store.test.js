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

  assert.equal(restored.cleaned, false);
  assert.deepEqual(restored.states.get("alpha"), {
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
      startedAt: "2026-07-20T10:00:00.000Z",
      lastSync: null,
      lastResult: null,
      error: null,
    },
  });
});
