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

function event() {
  let listener;
  return {
    addListener(value) { listener = value; },
    emit(...args) { return listener?.(...args); },
  };
}

function loadRuntime() {
  let runtimeListener;
  const counters = { accountLists: 0, capabilityReads: 0, alarmReads: 0 };
  const events = {
    accountCreated: event(),
    accountDeleted: event(),
    accountUpdated: event(),
    folderCopied: event(),
    folderCreated: event(),
    folderDeleted: event(),
    folderMoved: event(),
    folderRenamed: event(),
    folderUpdated: event(),
  };
  const config = {
    id: "sync-1",
    name: "Cached sync",
    accountA: "account-a",
    accountB: "account-b",
    folderA: { id: "folder-a", name: "A", path: "/A", specialUse: [] },
    folderB: { id: "folder-b", name: "B", path: "/B", specialUse: [] },
    direction: "both",
    autoSyncEnabled: true,
    autoSyncInterval: 5,
  };
  const storage = { syncConfigs: [clone(config)] };
  const accounts = [
    {
      id: "account-a",
      name: "Account A",
      type: "imap",
      rootFolder: { subFolders: [{ id: "folder-a", name: "A", path: "/A", specialUse: [] }] },
    },
    {
      id: "account-b",
      name: "Account B",
      type: "imap",
      rootFolder: { subFolders: [{ id: "folder-b", name: "B", path: "/B", specialUse: [] }] },
    },
  ];
  const noOpEvent = { addListener() {} };

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
      async set(values) { Object.assign(storage, clone(values)); },
      async remove(key) { delete storage[key]; },
    } },
    accounts: {
      async list() {
        counters.accountLists += 1;
        return clone(accounts);
      },
      onCreated: events.accountCreated,
      onDeleted: events.accountDeleted,
      onUpdated: events.accountUpdated,
    },
    alarms: {
      create: async () => {},
      clear: async () => {},
      async get() {
        counters.alarmReads += 1;
        return { name: "foldersync-auto-sync-sync-1", periodInMinutes: 5 };
      },
      getAll: async () => [{ name: "foldersync-auto-sync-sync-1", periodInMinutes: 5 }],
      onAlarm: noOpEvent,
    },
    folders: {
      async getFolderCapabilities() {
        counters.capabilityReads += 1;
        return { canAddMessages: true };
      },
      onCopied: events.folderCopied,
      onCreated: events.folderCreated,
      onDeleted: events.folderDeleted,
      onMoved: events.folderMoved,
      onRenamed: events.folderRenamed,
      onUpdated: events.folderUpdated,
    },
    messages: {
      list: async () => ({ messages: [] }),
      continueList: async () => ({ messages: [] }),
      copy: async () => {},
    },
    runtime: { onMessage: { addListener(listener) { runtimeListener = listener; } } },
    i18n: { getMessage: (key) => key },
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
    counters,
    events,
    accounts,
    send(message) {
      return new Promise((resolve) => runtimeListener(message, {}, resolve));
    },
  };
}

test("status polling does not scan accounts, capabilities, or individual alarms", async () => {
  const runtime = loadRuntime();

  const first = await runtime.send({ action: "getStatus" });
  const second = await runtime.send({ action: "getStatus" });

  assert.equal(first["sync-1"].autoSyncActive, true);
  assert.equal(second["sync-1"].status, "idle");
  assert.deepEqual(runtime.counters, {
    accountLists: 0,
    capabilityReads: 0,
    alarmReads: 0,
  });
});

test("account data is cached, force-refreshed, and invalidated by structure events", async () => {
  const runtime = loadRuntime();

  const initialAccounts = await runtime.send({ action: "getAccounts" });
  assert.deepEqual(initialAccounts[0].folders[0].specialUse, []);
  assert.equal("type" in initialAccounts[0].folders[0], false);
  await runtime.send({ action: "getAccounts" });
  assert.equal(runtime.counters.accountLists, 1);
  assert.equal(runtime.counters.capabilityReads, 2);

  await runtime.send({ action: "getAccounts", refresh: true });
  assert.equal(runtime.counters.accountLists, 2);
  assert.equal(runtime.counters.capabilityReads, 4);

  runtime.accounts[0].name = "Renamed Account A";
  await runtime.events.accountUpdated.emit("account-a", { name: "Renamed Account A" });
  const refreshed = await runtime.send({ action: "getAccounts" });
  assert.equal(refreshed[0].name, "Renamed Account A");
  assert.equal(runtime.counters.accountLists, 3);
  assert.equal(runtime.counters.capabilityReads, 6);

  await runtime.events.folderCreated.emit({ id: "new-folder" });
  await runtime.send({ action: "getAccounts" });
  assert.equal(runtime.counters.accountLists, 4);
  assert.equal(runtime.counters.capabilityReads, 8);
});

test("folder event validation errors stay current without status-time rescans", async () => {
  const runtime = loadRuntime();
  await runtime.send({ action: "getConfigs" });

  runtime.accounts[1].rootFolder.subFolders = [];
  await runtime.events.folderDeleted.emit({ id: "folder-b", path: "/B" });
  const invalid = await runtime.send({ action: "getStatus" });
  assert.equal(invalid["sync-1"].folderInvalid, true);
  assert.equal(invalid["sync-1"].status, "failed");

  runtime.accounts[1].rootFolder.subFolders = [
    { id: "folder-b-new", name: "B", path: "/B", specialUse: [] },
  ];
  await runtime.events.folderCreated.emit({ id: "folder-b-new", path: "/B" });
  const healed = await runtime.send({ action: "getStatus" });
  assert.equal(healed["sync-1"].folderInvalid, false);
  assert.equal(healed["sync-1"].error, null);
  assert.equal(healed["sync-1"].status, "idle");
});
