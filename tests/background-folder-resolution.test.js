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

function loadRuntime({ configs = [], capabilities = {}, specialUses = {} } = {}) {
  let runtimeListener;
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
      }] },
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
      }] },
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
      create: async () => {},
      clear: async () => {},
      get: async () => null,
      getAll: async () => [],
      onAlarm: event,
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
      list: async () => ({ messages: [] }),
      continueList: async () => ({ messages: [] }),
      copy: async () => {},
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
    folderA: { id: "stored-a", name: "Folder A", path: "/Folder A", specialUse: [] },
    folderB: { id: "stored-b", name: "Folder B", path: "/Folder B", specialUse: [] },
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
  assert.equal(runtime.storage.syncConfigs[0].folderA.id, "current-a");
  assert.equal(runtime.storage.syncConfigs[0].folderB.id, "current-b");
  assert.equal("canAddMessages" in runtime.storage.syncConfigs[0].folderA, false);
  assert.equal("canAddMessages" in runtime.storage.syncConfigs[0].folderB, false);
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
    folderA: { id: "old-a", name: "Folder A", path: "/Moved/Folder A", type: "inbox" },
    folderB: { id: "old-b", name: "Folder B", path: "/Folder B" },
  };
  const runtime = loadRuntime({
    configs: [existing],
    capabilities: { "current-a": true, "current-b": true },
    specialUses: { "current-a": ["inbox"] },
  });

  const configs = await runtime.send({ action: "getConfigs" });

  assert.deepEqual(configs[0].folderA.specialUse, ["inbox"]);
  assert.deepEqual(configs[0].folderB.specialUse, []);
  assert.equal("type" in runtime.storage.syncConfigs[0].folderA, false);
  assert.equal(runtime.storage.syncConfigs[0].folderA.id, "current-a");
  assert.equal(runtime.storage.syncConfigs[0].folderB.id, "current-b");
});

test("keeps a legacy descriptor unchanged when resolution fails", async () => {
  const existing = {
    ...config("both"),
    id: "unresolved-legacy",
    folderA: { id: "old-a", name: "Missing", path: "/Missing", type: "inbox" },
  };
  const runtime = loadRuntime({
    configs: [existing],
    capabilities: { "current-a": true, "current-b": true },
    specialUses: { "current-a": ["inbox"] },
  });

  await runtime.send({ action: "getConfigs" });

  assert.equal(runtime.storage.syncConfigs[0].folderA.type, "inbox");
  assert.equal("specialUse" in runtime.storage.syncConfigs[0].folderA, false);
});
