const test = require("node:test");
const assert = require("node:assert/strict");
const { runExclusive } = require("../sync-lock.js");

test("manual start and alarm cannot run the same sync concurrently", async () => {
  const state = { running: false };
  let releaseManual;
  const manualPaused = new Promise((resolve) => { releaseManual = resolve; });
  let executions = 0;

  const manualStart = runExclusive(state, async () => {
    executions += 1;
    await manualPaused;
    return "manual";
  });
  const alarmStart = runExclusive(state, async () => {
    executions += 1;
    return "alarm";
  });

  assert.deepEqual(await alarmStart, { started: false });
  assert.equal(executions, 1);
  releaseManual();
  assert.deepEqual(await manualStart, { started: true, value: "manual" });
  assert.equal(state.running, false);
});

test("releases the sync lock after an exception", async () => {
  const state = { running: false };

  await assert.rejects(runExclusive(state, async () => {
    throw new Error("failed");
  }), /failed/);

  assert.equal(state.running, false);
  assert.deepEqual(await runExclusive(state, async () => "retry"), {
    started: true,
    value: "retry",
  });
});
