const test = require("node:test");
const assert = require("node:assert/strict");
const Store = require("../config-alarm-store.js");

function fixture(configs = [], alarms = []) {
  const data = {
    configs: structuredClone(configs),
    alarms: new Map(alarms.map((alarm) => [alarm.name.replace("alarm-", ""), { ...alarm }])),
  };
  const deps = {
    saveConfigs: async (next) => { data.configs = structuredClone(next); },
    getAlarm: async (id) => data.alarms.get(id) || null,
    getAllAlarms: async () => [...data.alarms.values()],
    createAlarm: async (id, interval) => data.alarms.set(id, { name: `alarm-${id}`, periodInMinutes: interval }),
    clearAlarm: async (id) => data.alarms.delete(id),
    syncIdFromAlarm: (name) => name.startsWith("alarm-") ? name.slice(6) : null,
  };
  return { data, deps };
}

test("creates a config and its enabled alarm in one save", async () => {
  const { data, deps } = fixture();
  const config = { id: "new", autoSyncEnabled: true, autoSyncInterval: 10 };
  await Store.saveWithAlarm(config, [], [config], deps);
  assert.deepEqual(data.configs, [config]);
  assert.equal(data.alarms.get("new").periodInMinutes, 10);
});

test("rejects invalid intervals before an alarm or config is created", async () => {
  for (const interval of [0, 1441, 1.5, NaN, "5", "not-a-number", ""]) {
    const { data, deps } = fixture();
    let alarmCalls = 0;
    deps.createAlarm = async () => { alarmCalls += 1; };
    const config = { id: "invalid", autoSyncEnabled: true, autoSyncInterval: interval };
    await assert.rejects(Store.saveWithAlarm(config, [], [config], deps), RangeError);
    assert.equal(alarmCalls, 0);
    assert.deepEqual(data.configs, []);
  }
});

test("updates an enabled config and its alarm interval", async () => {
  const old = { id: "one", autoSyncEnabled: true, autoSyncInterval: 5 };
  const next = { ...old, autoSyncInterval: 15 };
  const { data, deps } = fixture([old], [{ name: "alarm-one", periodInMinutes: 5 }]);
  await Store.saveWithAlarm(next, [old], [next], deps);
  assert.deepEqual(data.configs, [next]);
  assert.equal(data.alarms.get("one").periodInMinutes, 15);
});

test("disables a config and removes its alarm", async () => {
  const old = { id: "one", autoSyncEnabled: true, autoSyncInterval: 5 };
  const next = { ...old, autoSyncEnabled: false };
  const { data, deps } = fixture([old], [{ name: "alarm-one", periodInMinutes: 5 }]);
  await Store.saveWithAlarm(next, [old], [next], deps);
  assert.deepEqual(data.configs, [next]);
  assert.equal(data.alarms.has("one"), false);
});

test("reports alarm creation failure and preserves the previous state", async () => {
  const config = { id: "new", autoSyncEnabled: true, autoSyncInterval: 10 };
  const { data, deps } = fixture();
  deps.createAlarm = async () => { throw new Error("alarm create failed"); };
  await assert.rejects(Store.saveWithAlarm(config, [], [config], deps), /alarm create failed/);
  assert.deepEqual(data.configs, []);
  assert.equal(data.alarms.size, 0);
});

test("rolls an update back when persisting the config fails", async () => {
  const old = { id: "one", autoSyncEnabled: true, autoSyncInterval: 5 };
  const next = { ...old, autoSyncInterval: 15 };
  const { data, deps } = fixture([old], [{ name: "alarm-one", periodInMinutes: 5 }]);
  let firstSave = true;
  const save = deps.saveConfigs;
  deps.saveConfigs = async (configs) => {
    if (firstSave) { firstSave = false; throw new Error("storage failed"); }
    await save(configs);
  };
  await assert.rejects(Store.saveWithAlarm(next, [old], [next], deps), /storage failed/);
  assert.deepEqual(data.configs, [old]);
  assert.equal(data.alarms.get("one").periodInMinutes, 5);
});

test("reports an alarm update failure and keeps the old interval", async () => {
  const old = { id: "one", autoSyncEnabled: true, autoSyncInterval: 5 };
  const next = { ...old, autoSyncInterval: 15 };
  const { data, deps } = fixture([old], [{ name: "alarm-one", periodInMinutes: 5 }]);
  deps.createAlarm = async (id, interval) => {
    if (interval === 15) throw new Error("alarm update failed");
    data.alarms.set(id, { name: `alarm-${id}`, periodInMinutes: interval });
  };
  await assert.rejects(Store.saveWithAlarm(next, [old], [next], deps), /alarm update failed/);
  assert.deepEqual(data.configs, [old]);
  assert.equal(data.alarms.get("one").periodInMinutes, 5);
});

test("reports alarm removal failure without disabling the stored config", async () => {
  const old = { id: "one", autoSyncEnabled: true, autoSyncInterval: 5 };
  const next = { ...old, autoSyncEnabled: false };
  const { data, deps } = fixture([old], [{ name: "alarm-one", periodInMinutes: 5 }]);
  deps.clearAlarm = async () => { throw new Error("alarm removal failed"); };
  await assert.rejects(Store.saveWithAlarm(next, [old], [next], deps), /alarm removal failed/);
  assert.deepEqual(data.configs, [old]);
  assert.equal(data.alarms.has("one"), true);
});

test("startup reconciliation repairs missing, stale, disabled, and orphan alarms", async () => {
  const configs = [
    { id: "missing", autoSyncEnabled: true, autoSyncInterval: 10 },
    { id: "stale", autoSyncEnabled: true, autoSyncInterval: 15 },
    { id: "disabled", autoSyncEnabled: false, autoSyncInterval: 5 },
  ];
  const { data, deps } = fixture(configs, [
    { name: "alarm-stale", periodInMinutes: 5 },
    { name: "alarm-disabled", periodInMinutes: 5 },
    { name: "alarm-orphan", periodInMinutes: 5 },
  ]);
  await Store.reconcile(configs, deps);
  assert.equal(data.alarms.get("missing").periodInMinutes, 10);
  assert.equal(data.alarms.get("stale").periodInMinutes, 15);
  assert.equal(data.alarms.has("disabled"), false);
  assert.equal(data.alarms.has("orphan"), false);
});
