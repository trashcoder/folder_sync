const test = require("node:test");
const assert = require("node:assert/strict");
const { runExclusive, runMutationExclusive } = require("../sync-lock.js");

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

test("rejects delete during a run without changing config, alarm, log, or status", async () => {
  const state = { running: false };
  const data = {
    config: { id: "alpha" },
    alarm: true,
    log: ["started"],
    status: state,
  };
  let releaseSync;
  const syncPaused = new Promise((resolve) => { releaseSync = resolve; });

  const sync = runExclusive(state, async () => syncPaused);
  const deletion = await runMutationExclusive(state, async () => {
    data.config = null;
    data.alarm = false;
    data.log = [];
    data.status = null;
  });

  assert.deepEqual(deletion, { started: false });
  assert.deepEqual(data.config, { id: "alpha" });
  assert.equal(data.alarm, true);
  assert.deepEqual(data.log, ["started"]);
  assert.equal(data.status, state);
  releaseSync();
  await sync;
});

test("rejects edit during a run and prevents a sync from racing a pending edit", async () => {
  const runningState = { running: false };
  let releaseSync;
  const syncPaused = new Promise((resolve) => { releaseSync = resolve; });
  const sync = runExclusive(runningState, async () => syncPaused);
  let name = "Original";

  const rejectedEdit = await runMutationExclusive(runningState, async () => {
    name = "Changed";
  });
  assert.deepEqual(rejectedEdit, { started: false });
  assert.equal(name, "Original");
  releaseSync();
  await sync;

  const editingState = { running: false };
  let releaseEdit;
  const editPaused = new Promise((resolve) => { releaseEdit = resolve; });
  const edit = runMutationExclusive(editingState, async () => {
    await editPaused;
    name = "Changed";
  });
  assert.deepEqual(await runExclusive(editingState, async () => "sync"), { started: false });
  releaseEdit();
  await edit;
  assert.equal(name, "Changed");
});
