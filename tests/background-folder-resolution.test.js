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
  extraFoldersA = [], extraFoldersB = [], messagesByFolder = {}, failedDestinations = [], beforeStorageSet = async () => {},
  beforeMessageList = async () => {} } = {}) {
  let runtimeListener;
  let alarmListener;
  const alarmNames = new Set();
  const copies = [];
  const event = { addListener() {} };
  const events = {};
  for (const name of ["onMoved", "onRenamed", "onDeleted", "onCreated", "onUpdated"]) {
    let listener;
    events[name] = {
      addListener(value) { listener = value; },
      emit(...args) { return listener?.(...args); },
    };
  }
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
        await beforeStorageSet(values);
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
      ...events,
    },
    messages: {
      list: async (folderId) => {
        await beforeMessageList(folderId);
        return { messages: clone(messagesByFolder[folderId] || []) };
      },
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
    accounts,
    events,
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
      folderA: { id: "old-a", name: "Folder A", path: "/Folder A", type: "inbox" },
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

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("concurrent additions retain both jobs and their alarms", async () => {
  const runtime = loadRuntime({ capabilities: { "current-a": true, "current-b": true } });
  const saved = await Promise.all(["First", "Second"].map((name) => runtime.send({
    action: "addConfig", config: { ...config("both"), name, autoSyncEnabled: true },
  })));
  assert.ok(saved.every((item) => !item.error));
  assert.deepEqual(runtime.storage.syncConfigs.map((item) => item.name), ["First", "Second"]);
  assert.equal(runtime.alarmNames.size, 2);
});

test("concurrent edit and deletion of different jobs do not overwrite each other", async () => {
  const runtime = loadRuntime({ configs: [
    { ...config("both"), id: "edit" }, { ...config("both"), id: "delete" },
  ], capabilities: { "current-a": true, "current-b": true } });
  const configs = await runtime.send({ action: "getConfigs" });
  const responses = await Promise.all([
    runtime.send({ action: "updateConfig", config: { ...configs[0], name: "Updated" } }),
    runtime.send({ action: "deleteConfig", syncId: "delete" }),
  ]);
  assert.ok(responses.every((response) => response.ok));
  assert.deepEqual(runtime.storage.syncConfigs.map(({ id, name }) => ({ id, name })),
    [{ id: "edit", name: "Updated" }]);
});

test("a failed write does not block subsequent queued configuration changes", async () => {
  let fail = true;
  const runtime = loadRuntime({ capabilities: { "current-a": true, "current-b": true },
    beforeStorageSet: async (values) => {
      if (values.syncConfigs?.some((item) => item.name === "Fail") && fail) {
        fail = false;
        throw new Error("storage unavailable");
      }
    },
  });
  const responses = await Promise.all(["Fail", "Keep"].map((name) => runtime.send({
    action: "addConfig", config: { ...config("both"), name },
  })));
  assert.match(responses[0].error, /storage unavailable/);
  assert.equal(responses[1].name, "Keep");
  assert.deepEqual(runtime.storage.syncConfigs.map((item) => item.name), ["Keep"]);
});

test("a running multi-mapping job cannot resurrect another deleted job", async () => {
  const scanning = deferred();
  const release = deferred();
  let paused = false;
  const setup = threeMappingSetup();
  // Session IDs need refreshing on later mappings, which forces config writes.
  setup.mappings[1].folderA.id = "previous-a2";
  const runtime = loadRuntime({ ...setup, configs: [
    { ...config("aToB"), id: "running", mappings: setup.mappings },
    { ...config("both"), id: "delete" },
  ], beforeMessageList: async () => {
    if (!paused) {
      paused = true;
      scanning.resolve();
      await release.promise;
    }
  } });
  const run = runtime.send({ action: "startSync", syncId: "running" });
  await scanning.promise;
  assert.equal((await runtime.send({ action: "deleteConfig", syncId: "delete" })).ok, true);
  release.resolve();
  assert.equal((await run).fatal, false);
  assert.deepEqual(runtime.storage.syncConfigs.map((item) => item.id), ["running"]);
});

for (const eventName of ["onRenamed", "onMoved"]) {
  test(`${eventName} only updates references in the affected account`, async () => {
    const existing = { ...config("both"), id: "job" };
    existing.mappings[0].folderB.path = "/Folder A";
    const runtime = loadRuntime({ configs: [existing],
      capabilities: { "current-a": true, "current-b": true, renamed: true },
    });
    runtime.accounts[1].rootFolder.subFolders[0].path = "/Folder A";
    const [saved] = await runtime.send({ action: "getConfigs" });
    const original = { ...runtime.accounts[0].rootFolder.subFolders[0], accountId: "account-a" };
    const updated = { ...original, id: "renamed", name: "Renamed", path: "/Renamed" };
    runtime.accounts[0].rootFolder.subFolders[0] = updated;
    await runtime.events[eventName].emit(original, updated);
    const mapping = runtime.storage.syncConfigs[0].mappings[0];
    assert.equal(mapping.folderA.path, "/Renamed");
    assert.deepEqual(mapping.folderB, saved.mappings[0].folderB);
    const result = await runtime.send({ action: "startSync", syncId: "job" });
    assert.equal(result.fatal, false, JSON.stringify(result));
  });
}

test("deleting a folder does not invalidate another account with the same path", async () => {
  const runtime = loadRuntime({ configs: [{ ...config("both"), id: "job" }],
    capabilities: { "current-a": true, "current-b": true },
  });
  await runtime.send({ action: "getConfigs" });
  await runtime.events.onDeleted.emit({ id: "unrelated", accountId: "other-account", path: "/Folder A" });
  assert.equal((await runtime.send({ action: "getStatus" })).job.folderInvalid, false);
  await runtime.events.onDeleted.emit({ id: "current-a", accountId: "account-a", path: "/Folder A" });
  assert.equal((await runtime.send({ action: "getStatus" })).job.folderInvalid, true);
});

test("an observed move across accounts leaves the job unavailable instead of changing its account pair", async () => {
  const runtime = loadRuntime({ configs: [{ ...config("both"), id: "job" }],
    capabilities: { "current-a": true, "current-b": true, moved: true },
  });
  await runtime.send({ action: "getConfigs" });
  const original = { ...runtime.accounts[0].rootFolder.subFolders[0], accountId: "account-a" };
  const moved = { ...original, id: "moved", accountId: "account-b", path: "/Moved" };
  runtime.accounts[0].rootFolder.subFolders = [];
  runtime.accounts[1].rootFolder.subFolders.push(moved);
  await runtime.events.onMoved.emit(original, moved);
  assert.equal(runtime.storage.syncConfigs[0].accountA, "account-a");
  assert.equal(runtime.storage.syncConfigs[0].mappings[0].folderA.path, original.path);
  const result = await runtime.send({ action: "startSync", syncId: "job" });
  assert.equal(result.fatal, true);
  assert.equal(runtime.copies.length, 0);
});

test("a missing source is not replaced by a same-named folder during sync", async () => {
  const existing = { ...config("aToB"), id: "missing" };
  existing.mappings[0].folderA.path = "/Deleted/Folder A";
  const runtime = loadRuntime({ configs: [existing],
    capabilities: { "current-a": true, "current-b": true },
    messagesByFolder: { "current-a": [{ id: 1, headerMessageId: "unique@example.test" }] },
  });
  const result = await runtime.send({ action: "startSync", syncId: "missing" });
  assert.equal(result.fatal, true);
  assert.equal(runtime.copies.length, 0);
  assert.equal(runtime.storage.syncConfigs[0].mappings[0].folderA.path, "/Deleted/Folder A");
});

test("final persistence retains the sync lock and blocks edits and deletions", async () => {
  const finishing = deferred();
  const release = deferred();
  let pause = true;
  const runtime = loadRuntime({ configs: [{ ...config("both"), id: "job" }],
    capabilities: { "current-a": true, "current-b": true },
    beforeStorageSet: async (values) => {
      if (values.syncStates?.job?.lastResult && !values.syncStates.job.running && pause) {
        pause = false;
        finishing.resolve();
        await release.promise;
      }
    },
  });
  const [saved] = await runtime.send({ action: "getConfigs" });
  const first = runtime.send({ action: "startSync", syncId: "job" });
  await finishing.promise;
  assert.equal((await runtime.send({ action: "getStatus" })).job.running, true);
  assert.match((await runtime.send({ action: "startSync", syncId: "job" })).error, /errorSyncRunning/);
  assert.match((await runtime.send({ action: "updateConfig", config: saved })).error, /errorConfigLocked/);
  assert.match((await runtime.send({ action: "deleteConfig", syncId: "job" })).error, /errorConfigLocked/);
  release.resolve();
  assert.equal((await first).fatal, false);
  assert.equal((await runtime.send({ action: "getStatus" })).job.running, false);
  assert.equal(runtime.storage.syncStates.job.running, false);
});

test("a folder rename racing an addition retains both the new job and updated reference", async () => {
  const runtime = loadRuntime({ configs: [{ ...config("both"), id: "original" }],
    capabilities: { "current-a": true, "current-b": true, renamed: true },
  });
  await runtime.send({ action: "getConfigs" });
  const original = { ...runtime.accounts[0].rootFolder.subFolders[0], accountId: "account-a" };
  const renamed = { ...original, id: "renamed", path: "/Renamed", name: "Renamed" };
  runtime.accounts[0].rootFolder.subFolders[0] = renamed;
  const added = config("both");
  added.mappings[0].folderA = renamed;
  const [, saved] = await Promise.all([
    runtime.events.onRenamed.emit(original, renamed),
    runtime.send({ action: "addConfig", config: added }),
  ]);
  assert.equal(saved.error, undefined);
  assert.equal(runtime.storage.syncConfigs.length, 2);
  assert.ok(runtime.storage.syncConfigs.every((item) => item.mappings[0].folderA.path === "/Renamed"));
});
