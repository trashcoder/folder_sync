const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ConfigAlarmStore = require("../config-alarm-store.js");
const FolderResolver = require("../folder-resolver.js");
const IntervalValidator = require("../interval-validator.js");
const MessageMatcher = require("../message-matcher.js");
const SyncLock = require("../sync-lock.js");
const SyncStateStore = require("../sync-state-store.js");

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function loadRuntime({ configs = [], capabilities = {}, specialUses = {},
  extraFoldersA = [], extraFoldersB = [], messagesByFolder = {}, failedDestinations = [] } = {}) {
  let runtimeListener;
  let alarmListener;
  const alarmNames = new Set();
  const copies = [];
  const event = { addListener() {} };
  const storage = { syncConfigs: clone(configs) };
  const accounts = [
    {
      id: "account-a",
      name: "Account A",
      type: "imap",
      rootFolder: { subFolders: [{
        id: "current-a",
        name: "Folder A",
        path: "/Folder A",
        specialUse: specialUses["current-a"] || [],
      }, ...extraFoldersA] },
    },
    {
      id: "account-b",
      name: "Account B",
      type: "imap",
      rootFolder: { subFolders: [{
        id: "current-b",
        name: "Folder B",
        path: "/Folder B",
        specialUse: specialUses["current-b"] || [],
      }, ...extraFoldersB] },
    },
  ];

  const messenger = {
    storage: { local: {
      async get(keys) {
        const requested = Array.isArray(keys) ? keys : [keys];
        const result = {};
        for (const key of requested) {
          if (Object.hasOwn(storage, key)) result[key] = clone(storage[key]);
        }
        return result;
      },
      async set(values) {
        for (const [key, value] of Object.entries(values)) storage[key] = clone(value);
      },
      async remove(key) { delete storage[key]; },
    } },
    accounts: { list: async () => clone(accounts) },
    alarms: {
      create: async (name) => { alarmNames.add(name); },
      clear: async (name) => { alarmNames.delete(name); },
      get: async (name) => alarmNames.has(name) ? { name, periodInMinutes: 5 } : null,
      getAll: async () => [...alarmNames].map((name) => ({ name, periodInMinutes: 5 })),
      onAlarm: { addListener(listener) { alarmListener = listener; } },
    },
    folders: {
      getFolderCapabilities: async (folderId) => ({
        canAddMessages: capabilities[folderId] === true,
      }),
      onMoved: event,
      onRenamed: event,
      onDeleted: event,
    },
    messages: {
      list: async (folderId) => ({ messages: clone(messagesByFolder[folderId] || []) }),
      continueList: async () => ({ messages: [] }),
      copy: async (ids, folderId) => {
        if (failedDestinations.includes(folderId)) throw new Error("copy rejected");
        copies.push({ ids: clone(ids), folderId });
      },
    },
    runtime: { onMessage: { addListener(listener) { runtimeListener = listener; } } },
    i18n: {
      getMessage(key, substitutions = []) {
        return substitutions.length ? `${key}: ${substitutions.join(",")}` : key;
      },
    },
  };
  const context = {
    messenger,
    ConfigAlarmStore,
    FolderResolver,
    IntervalValidator,
    MessageMatcher,
    SyncLock,
    SyncStateStore,
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
  };
  const source = fs.readFileSync(path.join(__dirname, "../background.js"), "utf8");
  vm.runInNewContext(source, context, { filename: "background.js" });

  return {
    storage,
    copies,
    alarmNames,
    emitAlarm(syncId) { return alarmListener({ name: `foldersync-auto-sync-${syncId}` }); },
    send(message) {
      return new Promise((resolve) => runtimeListener(message, {}, resolve));
    },
  };
}

function config(direction) {
  return {
    name: direction,
    accountA: "account-a",
    accountB: "account-b",
    mappings: [{
      folderA: { id: "stored-a", name: "Folder A", path: "/Folder A", specialUse: [] },
      folderB: { id: "stored-b", name: "Folder B", path: "/Folder B", specialUse: [] },
    }],
    direction,
    autoSyncEnabled: false,
    autoSyncInterval: 5,
  };
}

test("saves new configurations when every destination is writable", async () => {
  const scenarios = [
    ["both", { "current-a": true, "current-b": true }],
    ["aToB", { "current-a": false, "current-b": true }],
    ["bToA", { "current-a": true, "current-b": false }],
  ];

  for (const [direction, capabilities] of scenarios) {
    const runtime = loadRuntime({ capabilities });
    const response = await runtime.send({ action: "addConfig", config: config(direction) });
    assert.equal(response.error, undefined, direction);
    assert.equal(runtime.storage.syncConfigs.length, 1, direction);
  }
});

test("rejects new configurations with a non-writable destination", async () => {
  const scenarios = [
    ["both", { "current-a": true, "current-b": false }, "B"],
    ["aToB", { "current-a": true, "current-b": false }, "B"],
    ["bToA", { "current-a": false, "current-b": true }, "A"],
  ];

  for (const [direction, capabilities, side] of scenarios) {
    const runtime = loadRuntime({ capabilities });
    const response = await runtime.send({ action: "addConfig", config: config(direction) });
    assert.match(response.error, new RegExp(`errorFolderNotWritable: ${side}`), direction);
    assert.equal(runtime.storage.syncConfigs.length, 0, direction);
  }
});

test("starts an existing configuration with resolved writable folders", async () => {
  const existing = { ...config("both"), id: "existing" };
  const runtime = loadRuntime({
    configs: [existing],
    capabilities: { "current-a": true, "current-b": true },
  });

  const result = await runtime.send({ action: "startSync", syncId: "existing" });

  assert.equal(result.fatal, false);
  assert.equal(result.errors.length, 0);
  assert.equal(runtime.storage.syncConfigs[0].mappings[0].folderA.id, "current-a");
  assert.equal(runtime.storage.syncConfigs[0].mappings[0].folderB.id, "current-b");
  assert.equal("canAddMessages" in runtime.storage.syncConfigs[0].mappings[0].folderA, false);
  assert.equal("canAddMessages" in runtime.storage.syncConfigs[0].mappings[0].folderB, false);
});

test("migrates and deletes a configuration without a legacy sync ID", async () => {
  const runtime = loadRuntime({
    configs: [config("both")],
    capabilities: { "current-a": true, "current-b": true },
  });

  const configs = await runtime.send({ action: "getConfigs" });
  assert.equal(typeof configs[0].id, "string");
  assert.ok(configs[0].id.length > 0);
  assert.equal(runtime.storage.syncConfigs[0].id, configs[0].id);

  const response = await runtime.send({ action: "deleteConfig", syncId: configs[0].id });

  assert.equal(response.ok, true);
  assert.deepEqual(runtime.storage.syncConfigs, []);
});

test("migrates legacy folder descriptors only after both folders resolve", async () => {
  const existing = {
    ...config("both"),
    id: "legacy",
    mappings: [{
      folderA: { id: "old-a", name: "Folder A", path: "/Moved/Folder A", type: "inbox" },
      folderB: { id: "old-b", name: "Folder B", path: "/Folder B" },
    }],
  };
  const runtime = loadRuntime({
    configs: [existing],
    capabilities: { "current-a": true, "current-b": true },
    specialUses: { "current-a": ["inbox"] },
  });

  const configs = await runtime.send({ action: "getConfigs" });

  assert.deepEqual(configs[0].mappings[0].folderA.specialUse, ["inbox"]);
  assert.deepEqual(configs[0].mappings[0].folderB.specialUse, []);
  assert.equal("type" in runtime.storage.syncConfigs[0].mappings[0].folderA, false);
  assert.equal(runtime.storage.syncConfigs[0].mappings[0].folderA.id, "current-a");
  assert.equal(runtime.storage.syncConfigs[0].mappings[0].folderB.id, "current-b");
});

test("keeps a legacy descriptor unchanged when resolution fails", async () => {
  const existing = {
    ...config("both"),
    id: "unresolved-legacy",
    mappings: [{
      folderA: { id: "old-a", name: "Missing", path: "/Missing", type: "inbox" },
      folderB: config("both").mappings[0].folderB,
    }],
  };
  const runtime = loadRuntime({
    configs: [existing],
    capabilities: { "current-a": true, "current-b": true },
    specialUses: { "current-a": ["inbox"] },
  });

  await runtime.send({ action: "getConfigs" });

  assert.equal(runtime.storage.syncConfigs[0].mappings[0].folderA.type, "inbox");
  assert.equal("specialUse" in runtime.storage.syncConfigs[0].mappings[0].folderA, false);
});

function folder(id, name) {
  return { id, name, path: `/${name}`, specialUse: [] };
}

function threeMappingSetup(overrides = {}) {
  const extraFoldersA = [folder("a2", "A2"), folder("a3", "A3")];
  const extraFoldersB = [folder("b2", "B2"), folder("b3", "B3")];
  const mappings = [
    { folderA: folder("current-a", "Folder A"), folderB: folder("current-b", "Folder B") },
    { folderA: folder("a2", "A2"), folderB: folder("b2", "B2") },
    { folderA: folder("a3", "A3"), folderB: folder("b3", "B3") },
  ];
  const capabilities = Object.fromEntries(
    ["current-a", "a2", "a3", "current-b", "b2", "b3"].map((id) => [id, true])
  );
  const messagesByFolder = Object.fromEntries(
    ["current-a", "a2", "a3"].map((id) =>
      [id, [{ id: `message-${id}`, headerMessageId: `<${id}@example.test>` }]])
  );
  return { extraFoldersA, extraFoldersB, capabilities, messagesByFolder, mappings, ...overrides };
}

test("saves three explicit mappings and runs all of them manually and by alarm", async () => {
  const setup = threeMappingSetup();
  const runtime = loadRuntime(setup);
  const job = { ...config("aToB"), mappings: setup.mappings,
    autoSyncEnabled: true, autoSyncInterval: 5 };
  const saved = await runtime.send({ action: "addConfig", config: job });
  assert.equal(saved.mappings.length, 3);
  assert.ok(saved.mappings.every((mapping) => mapping.id));
  assert.equal((await runtime.send({ action: "getConfigs" }))[0].mappings.length, 3);
  assert.ok(runtime.alarmNames.has(`foldersync-auto-sync-${saved.id}`));

  const result = await runtime.send({ action: "startSync", syncId: saved.id });
  assert.equal(result.mappings.length, 3);
  assert.equal(result.copiedAtoB, 3);
  assert.equal(result.errors.length, 0);
  assert.deepEqual(runtime.copies.map((copy) => copy.folderId), ["current-b", "b2", "b3"]);
  const status = await runtime.send({ action: "getStatus" });
  assert.equal(status[saved.id].status, "success");
  assert.equal(status[saved.id].lastResult.mappings.length, 3);

  await runtime.emitAlarm(saved.id);
  assert.equal(runtime.copies.length, 6);
});

test("rejects empty, duplicate, and non-writable mappings without saving a job", async () => {
  const setup = threeMappingSetup();
  const runtime = loadRuntime(setup);
  const base = { ...config("aToB"), mappings: [] };
  assert.match((await runtime.send({ action: "addConfig", config: base })).error, /errorNoFolders/);
  assert.match((await runtime.send({ action: "addConfig", config: {
    ...base, mappings: [setup.mappings[0], setup.mappings[0]],
  } })).error, /errorDuplicateMapping/);
  const unwritable = loadRuntime(threeMappingSetup({
    capabilities: { ...setup.capabilities, b2: false },
  }));
  assert.match((await unwritable.send({ action: "addConfig", config: {
    ...base, mappings: setup.mappings,
  } })).error, /errorFolderNotWritable/);
  assert.equal(runtime.storage.syncConfigs.length, 0);
  assert.equal(unwritable.storage.syncConfigs.length, 0);
});

test("one failed mapping keeps successful mapping counts and marks the job partial", async () => {
  const setup = threeMappingSetup({ failedDestinations: ["b2"] });
  const runtime = loadRuntime({ ...setup, configs: [{
    ...config("aToB"), id: "partial", mappings: setup.mappings,
  }] });
  const result = await runtime.send({ action: "startSync", syncId: "partial" });
  assert.equal(result.copiedAtoB, 2);
  assert.equal(result.mappings[0].copiedAtoB, 1);
  assert.equal(result.mappings[1].errors.length, 1);
  assert.equal(result.mappings[2].copiedAtoB, 1);
  assert.equal((await runtime.send({ action: "getStatus" })).partial.status, "partialFailure");
});

test("0.2.x jobs retain direction and automatic sync after migration", async () => {
  const legacy = { ...config("bToA"), id: "old", autoSyncEnabled: true };
  const mapping = legacy.mappings[0];
  delete legacy.mappings;
  legacy.folderA = mapping.folderA;
  legacy.folderB = mapping.folderB;
  const runtime = loadRuntime({ configs: [legacy],
    capabilities: { "current-a": true, "current-b": true } });
  const [migrated] = await runtime.send({ action: "getConfigs" });
  assert.equal(migrated.direction, "bToA");
  assert.equal(migrated.autoSyncEnabled, true);
  assert.equal(migrated.mappings.length, 1);
  assert.equal(migrated.folderA, undefined);
  assert.ok(runtime.alarmNames.has("foldersync-auto-sync-old"));
  assert.equal((await runtime.send({ action: "startSync", syncId: "old" })).fatal, false);
});

test("jobs sharing account A have separate mappings, alarms, and results", async () => {
  const setup = threeMappingSetup();
  const runtime = loadRuntime(setup);
  const first = await runtime.send({ action: "addConfig", config: {
    ...config("aToB"), mappings: [setup.mappings[0]], autoSyncEnabled: true,
  } });
  const second = await runtime.send({ action: "addConfig", config: {
    ...config("aToB"), mappings: [setup.mappings[1]], autoSyncEnabled: true,
  } });
  assert.notEqual(first.id, second.id);
  assert.equal(runtime.alarmNames.size, 2);
  await runtime.send({ action: "startSync", syncId: first.id });
  assert.equal((await runtime.send({ action: "getStatus" }))[second.id].lastResult, null);
  await runtime.emitAlarm(second.id);
  assert.deepEqual(runtime.copies.map((copy) => copy.folderId), ["current-b", "b2"]);
});

test("an unresolved mapping does not prevent later mappings from succeeding", async () => {
  const setup = threeMappingSetup();
  const mappings = setup.mappings.map((mapping) => clone(mapping));
  mappings[1].folderA = folder("missing", "Missing");
  const runtime = loadRuntime({ ...setup, configs: [{
    ...config("aToB"), id: "unresolved", mappings,
  }] });
  const result = await runtime.send({ action: "startSync", syncId: "unresolved" });
  assert.equal(result.copiedAtoB, 2);
  assert.equal(result.mappings[1].fatal, true);
  assert.equal(result.mappings[2].copiedAtoB, 1);
  assert.equal((await runtime.send({ action: "getStatus" })).unresolved.status, "partialFailure");
  assert.equal((await runtime.send({ action: "getStatus" })).unresolved.folderInvalid, true);
  assert.equal((await runtime.send({ action: "getLog", syncId: "unresolved" })).length > 0, true);
});

test("editing mappings preserves the job alarm and deleting removes job data", async () => {
  const setup = threeMappingSetup();
  const runtime = loadRuntime(setup);
  const saved = await runtime.send({ action: "addConfig", config: {
    ...config("aToB"), mappings: setup.mappings,
    autoSyncEnabled: true,
  } });
  const updated = { ...saved, mappings: saved.mappings.slice(0, 2) };
  assert.equal((await runtime.send({ action: "updateConfig", config: updated })).ok, true);
  assert.equal((await runtime.send({ action: "getConfigs" }))[0].mappings.length, 2);
  assert.ok(runtime.alarmNames.has(`foldersync-auto-sync-${saved.id}`));
  await runtime.send({ action: "startSync", syncId: saved.id });
  assert.equal((await runtime.send({ action: "getStatus" }))[saved.id].lastResult.mappings.length, 2);
  assert.equal((await runtime.send({ action: "deleteConfig", syncId: saved.id })).ok, true);
  assert.equal(runtime.storage.syncConfigs.length, 0);
  assert.equal(runtime.alarmNames.size, 0);
  assert.equal(runtime.storage[`syncLog_${saved.id}`], undefined);
});
