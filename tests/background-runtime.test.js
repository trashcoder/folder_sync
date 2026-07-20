const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const IntervalValidator = require("../interval-validator.js");
const ConfigAlarmStore = require("../config-alarm-store.js");
const SyncStateStore = require("../sync-state-store.js");
const SyncLock = require("../sync-lock.js");

function loadRuntimeListener() {
  let runtimeListener;
  let alarmCreateCalls = 0;
  const event = { addListener() {} };
  const messenger = {
    storage: { local: {
      get: async () => ({}),
      set: async () => {},
      remove: async () => {},
    } },
    alarms: {
      create: async () => { alarmCreateCalls += 1; },
      clear: async () => {},
      get: async () => null,
      getAll: async () => [],
      onAlarm: event,
    },
    folders: { onMoved: event, onRenamed: event, onDeleted: event },
    runtime: { onMessage: { addListener(listener) { runtimeListener = listener; } } },
    i18n: { getMessage: (key) => key },
  };
  const context = {
    messenger,
    IntervalValidator,
    ConfigAlarmStore,
    SyncStateStore,
    SyncLock,
    FolderResolver: {},
    MessageMatcher: {},
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
  };
  const source = fs.readFileSync(path.join(__dirname, "../background.js"), "utf8");
  vm.runInNewContext(source, context, { filename: "background.js" });
  return {
    send(message) {
      return new Promise((resolve) => runtimeListener(message, {}, resolve));
    },
    alarmCreateCalls: () => alarmCreateCalls,
  };
}

test("direct runtime messages cannot create alarms with invalid intervals", async () => {
  const runtime = loadRuntimeListener();
  for (const intervalMinutes of [0, 1441, 1.5, NaN, "5", "nope", "", null, undefined]) {
    const response = await runtime.send({ action: "startAutoSync", syncId: "direct", intervalMinutes });
    assert.match(response.error, /integer from 1 to 1440/);
  }
  assert.equal(runtime.alarmCreateCalls(), 0);
});

test("direct runtime messages accept both valid interval boundaries", async () => {
  const runtime = loadRuntimeListener();
  assert.equal((await runtime.send({ action: "startAutoSync", syncId: "min", intervalMinutes: 1 })).ok, true);
  assert.equal((await runtime.send({ action: "startAutoSync", syncId: "max", intervalMinutes: 1440 })).ok, true);
  assert.equal(runtime.alarmCreateCalls(), 2);
});
