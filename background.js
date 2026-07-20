const ALARM_PREFIX = "foldersync-auto-sync-";

// Durable fields are persisted; progress remains intentionally UI-only.
const syncStates = new Map();
const syncStatesReady = restoreSyncStates();

async function persistSyncStates(overrides = {}) {
  const statesToPersist = new Map(syncStates);
  for (const [syncId, override] of Object.entries(overrides)) {
    const state = statesToPersist.get(syncId);
    if (state) statesToPersist.set(syncId, { ...state, ...override });
  }
  await messenger.storage.local.set({
    [SyncStateStore.STORAGE_KEY]: SyncStateStore.serialize(statesToPersist),
  });
}

async function restoreSyncStates() {
  try {
    const data = await messenger.storage.local.get(SyncStateStore.STORAGE_KEY);
    const restored = SyncStateStore.restore(
      data[SyncStateStore.STORAGE_KEY],
      messenger.i18n.getMessage("errorSyncInterrupted")
    );
    for (const [syncId, state] of restored.states) syncStates.set(syncId, state);
    if (restored.cleaned) await persistSyncStates();
  } catch (err) {
    console.error("FolderSync: failed to restore sync states:", err);
  }
}

function getSyncState(syncId) {
  if (!syncStates.has(syncId)) {
    syncStates.set(syncId, SyncStateStore.emptyState());
  }
  return syncStates.get(syncId);
}

function setSyncProgress(state, progress) {
  state.progress = progress;
}

function updateCopyProgress(state, direction, completed, total) {
  const failed = state.progress?.failed || 0;
  const processed = completed + failed;
  setSyncProgress(state, {
    phase: "copy",
    direction,
    completed,
    failed,
    total,
    remaining: Math.max(total - processed, 0),
  });
}

function updateCopyFailureProgress(state, direction, completed, failed, total) {
  setSyncProgress(state, {
    phase: "copy",
    direction,
    completed,
    failed,
    total,
    remaining: Math.max(total - completed - failed, 0),
  });
}

// --- Log persistence ---

const MAX_LOG_ENTRIES = 200;

async function appendLog(syncId, level, message) {
  try {
    const key = `syncLog_${syncId}`;
    const data = await messenger.storage.local.get(key);
    const entries = data[key] || [];
    entries.push({ ts: new Date().toISOString(), level, message });
    if (entries.length > MAX_LOG_ENTRIES) entries.splice(0, entries.length - MAX_LOG_ENTRIES);
    await messenger.storage.local.set({ [key]: entries });
  } catch (e) {
    // ignore logging errors
  }
}

async function loadLog(syncId) {
  try {
    const key = `syncLog_${syncId}`;
    const data = await messenger.storage.local.get(key);
    return data[key] || [];
  } catch (e) {
    return [];
  }
}

async function clearLog(syncId) {
  try {
    await messenger.storage.local.remove(`syncLog_${syncId}`);
  } catch (e) {
    // ignore
  }
}

// --- Message pagination helper ---

async function* getMessages(folder) {
  let page = await messenger.messages.list(folder.id);
  for (const message of page.messages) {
    yield message;
  }
  while (page.id) {
    page = await messenger.messages.continueList(page.id);
    for (const message of page.messages) {
      yield message;
    }
  }
}

async function collectMessagesByIdentity(folder) {
  const groups = new Map();
  let count = 0;
  let fallbackCount = 0;
  for await (const msg of getMessages(folder)) {
    MessageMatcher.addMessage(groups, msg);
    count += 1;
    if (!String(msg.headerMessageId || "").trim()) fallbackCount += 1;
  }
  return { groups, count, fallbackCount };
}

// --- Sync engine (bidirectional) ---

async function syncFolders(syncId, folderA, folderB, direction = "both") {
  const state = getSyncState(syncId);
  state.error = null;
  setSyncProgress(state, {
    phase: "prepare",
    direction: null,
    completed: 0,
    total: 0,
    remaining: 0,
  });

  const result = {
    checkedA: 0,
    checkedB: 0,
    fallbackA: 0,
    fallbackB: 0,
    ignoredA: 0,
    ignoredB: 0,
    copiedAtoB: 0,
    copiedBtoA: 0,
    errors: [],
    fatal: false,
  };

  await appendLog(syncId, "info", `Sync started (${direction}): ${folderA.name} ↔ ${folderB.name}`);

  try {
    const [messagesA, messagesB] = await Promise.all([
      collectMessagesByIdentity(folderA),
      collectMessagesByIdentity(folderB),
    ]);

    result.checkedA = messagesA.count;
    result.checkedB = messagesB.count;
    result.fallbackA = messagesA.fallbackCount;
    result.fallbackB = messagesB.fallbackCount;
    result.ignoredA = 0;
    result.ignoredB = 0;

    if (messagesA.fallbackCount || messagesB.fallbackCount) {
      await appendLog(syncId, "info", `Fallback matching (no Message-ID): A ${messagesA.fallbackCount}, B ${messagesB.fallbackCount}; ignored: A 0, B 0`);
    }

    let missingInB = [];
    if (direction === "both" || direction === "aToB") {
      missingInB = MessageMatcher.missingMessageIds(messagesA.groups, messagesB.groups);
    }

    let missingInA = [];
    if (direction === "both" || direction === "bToA") {
      missingInA = MessageMatcher.missingMessageIds(messagesB.groups, messagesA.groups);
    }

    const totalToCopy = missingInB.length + missingInA.length;
    let totalCopied = 0;
    updateCopyProgress(state, direction, totalCopied, totalToCopy);

    // Copy A -> B
    if (missingInB.length > 0) {
      const batchSize = 50;
      for (let i = 0; i < missingInB.length; i += batchSize) {
        const batch = missingInB.slice(i, i + batchSize);
        try {
          await assertFolderWritable(folderB, "B");
          await messenger.messages.copy(batch, folderB.id);
          result.copiedAtoB += batch.length;
          totalCopied += batch.length;
          updateCopyProgress(state, "aToB", totalCopied, totalToCopy);
        } catch (err) {
          const msg = `A→B batch ${i}: ${err.message}`;
          result.errors.push(msg);
          updateCopyFailureProgress(state, "aToB", totalCopied, (state.progress?.failed || 0) + batch.length, totalToCopy);
          await appendLog(syncId, "error", msg);
        }
      }
    }

    // Copy B -> A
    if (missingInA.length > 0) {
      const batchSize = 50;
      for (let i = 0; i < missingInA.length; i += batchSize) {
        const batch = missingInA.slice(i, i + batchSize);
        try {
          await assertFolderWritable(folderA, "A");
          await messenger.messages.copy(batch, folderA.id);
          result.copiedBtoA += batch.length;
          totalCopied += batch.length;
          updateCopyProgress(state, "bToA", totalCopied, totalToCopy);
        } catch (err) {
          const msg = `B→A batch ${i}: ${err.message}`;
          result.errors.push(msg);
          updateCopyFailureProgress(state, "bToA", totalCopied, (state.progress?.failed || 0) + batch.length, totalToCopy);
          await appendLog(syncId, "error", msg);
        }
      }
    }
  } catch (err) {
    result.fatal = true;
    result.errors.push(err.message);
    await appendLog(syncId, "error", `Fatal: ${err.message}`);
  }

  SyncStateStore.complete(state, result, result.fatal ? result.errors[0] : null, new Date().toISOString());

  const summary = `Done: A→B ${result.copiedAtoB}, B→A ${result.copiedBtoA}` +
    (result.errors.length ? `, ${result.errors.length} error(s)` : "");
  await appendLog(syncId, result.errors.length > 0 ? "error" : "info", summary);

  return result;
}

// --- Account & folder helpers ---

async function getAccountsWithFolders() {
  const accounts = await messenger.accounts.list(true);
  console.log("FolderSync: raw accounts:", JSON.stringify(accounts.map(a => ({ id: a.id, name: a.name, type: a.type, hasRootFolder: !!a.rootFolder }))));
  return await Promise.all(accounts
    .filter((account) => account.type !== "none" && account.type !== "nntp")
    .map(async (account) => ({
      id: account.id,
      name: account.name,
      type: account.type,
      folders: await addFolderCapabilities(flattenFolders(account.rootFolder?.subFolders || [])),
    })));
}

async function addFolderCapabilities(folders) {
  return await Promise.all(folders.map(async (folder) => {
    try {
      const capabilities = await messenger.folders.getFolderCapabilities(folder.id);
      return { ...folder, canAddMessages: capabilities.canAddMessages === true };
    } catch (err) {
      console.warn(`FolderSync: failed to read capabilities for ${folder.id}:`, err);
      return { ...folder, canAddMessages: false };
    }
  }));
}

async function assertFolderWritable(folder, side) {
  const capabilities = await messenger.folders.getFolderCapabilities(folder.id);
  if (capabilities.canAddMessages !== true) {
    throw new Error(messenger.i18n.getMessage("errorFolderNotWritable", [side]));
  }
}

function flattenFolders(folders, prefix = "") {
  const result = [];
  for (const folder of folders) {
    const path = folder.path || (prefix ? `${prefix}/${folder.name}` : folder.name);
    result.push({
      id: folder.id,
      name: folder.name,
      path: path,
      type: folder.type,
    });
    if (folder.subFolders && folder.subFolders.length > 0) {
      result.push(...flattenFolders(folder.subFolders, path));
    }
  }
  return result;
}

// --- Config persistence (multi-sync) ---

async function saveConfigs(configs) {
  await messenger.storage.local.set({ syncConfigs: configs });
}

async function loadConfigs() {
  const data = await messenger.storage.local.get(["syncConfigs", "syncConfig"]);

  // Migration: convert old single config to array
  if (!data.syncConfigs && data.syncConfig) {
    const oldConfig = data.syncConfig;
    const migrated = [{
      ...oldConfig,
      id: generateId(),
      name: `${oldConfig.folderA?.name || "A"} ↔ ${oldConfig.folderB?.name || "B"}`,
    }];
    await messenger.storage.local.set({ syncConfigs: migrated });
    await messenger.storage.local.remove("syncConfig");
    return migrated;
  }

  return data.syncConfigs || [];
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function folderResolutionError(side, reason) {
  const key = reason === "ambiguous" ? "errorFolderAmbiguous" : "errorFolderNotFound";
  return messenger.i18n.getMessage(key, [side]);
}

async function resolveConfigFolders(config, accounts = null) {
  const currentAccounts = accounts || await getAccountsWithFolders();
  const resolved = {};
  for (const side of ["A", "B"]) {
    const account = currentAccounts.find((item) => item.id === config[`account${side}`]);
    if (!account) throw new Error(messenger.i18n.getMessage("errorAccountNotFound", [side]));
    const result = FolderResolver.resolveFolder(config[`folder${side}`], account.folders);
    if (!result.folder) throw new Error(folderResolutionError(side, result.error));
    resolved[`folder${side}`] = result.folder;
  }
  validateResolvedFolders(resolved.folderA, resolved.folderB, config.direction || "both");
  return resolved;
}

function validateResolvedFolders(folderA, folderB, direction) {
  if (folderA.id === folderB.id) {
    throw new Error(messenger.i18n.getMessage("errorFoldersIdentical"));
  }
  if ((direction === "both" || direction === "bToA") && folderA.canAddMessages !== true) {
    throw new Error(messenger.i18n.getMessage("errorFolderNotWritable", ["A"]));
  }
  if ((direction === "both" || direction === "aToB") && folderB.canAddMessages !== true) {
    throw new Error(messenger.i18n.getMessage("errorFolderNotWritable", ["B"]));
  }
}

async function validateConfig(config) {
  IntervalValidator.assertValid(config.autoSyncInterval);
  await resolveConfigFolders(config);
}

async function resolveAndPersistConfig(config, configs) {
  const resolved = await resolveConfigFolders(config);
  const changed = ["A", "B"].some((side) => {
    const oldFolder = config[`folder${side}`];
    const newFolder = resolved[`folder${side}`];
    return oldFolder.id !== newFolder.id || oldFolder.path !== newFolder.path ||
      oldFolder.name !== newFolder.name || oldFolder.type !== newFolder.type;
  });
  if (changed) {
    for (const side of ["A", "B"]) {
      config[`folder${side}`] = FolderResolver.descriptor(resolved[`folder${side}`]);
    }
    await saveConfigs(configs);
  }
  return resolved;
}

async function refreshConfigFolderReferences(configs) {
  const accounts = await getAccountsWithFolders();
  let changed = false;
  for (const config of configs) {
    try {
      const resolved = await resolveConfigFolders(config, accounts);
      for (const side of ["A", "B"]) {
        const key = `folder${side}`;
        const descriptor = FolderResolver.descriptor(resolved[key]);
        if (JSON.stringify(config[key]) !== JSON.stringify(descriptor)) {
          config[key] = descriptor;
          changed = true;
        }
      }
    } catch (err) {
      // Keep the persisted reference so the edit view can show the invalid config.
    }
  }
  if (changed) await saveConfigs(configs);
  return configs;
}

// --- Auto-sync via alarms (per-sync) ---

function alarmName(syncId) {
  return ALARM_PREFIX + syncId;
}

async function startAutoSync(syncId, intervalMinutes) {
  IntervalValidator.assertValid(intervalMinutes);
  await messenger.alarms.create(alarmName(syncId), {
    periodInMinutes: intervalMinutes,
  });
}

async function stopAutoSync(syncId) {
  await messenger.alarms.clear(alarmName(syncId));
}

async function isAutoSyncActive(syncId) {
  const alarm = await messenger.alarms.get(alarmName(syncId));
  return !!alarm;
}

function configAlarmDependencies() {
  return {
    saveConfigs,
    getAlarm: (syncId) => messenger.alarms.get(alarmName(syncId)),
    getAllAlarms: () => messenger.alarms.getAll(),
    createAlarm: startAutoSync,
    clearAlarm: stopAutoSync,
    syncIdFromAlarm: (name) => name.startsWith(ALARM_PREFIX) ? name.slice(ALARM_PREFIX.length) : null,
  };
}

const configAlarmsReady = (async () => {
  try {
    await ConfigAlarmStore.reconcile(await loadConfigs(), configAlarmDependencies());
  } catch (err) {
    console.error("FolderSync: failed to reconcile automatic sync alarms:", err);
  }
})();

async function startSyncExclusive(syncId) {
  await syncStatesReady;
  const state = getSyncState(syncId);
  return await SyncLock.runExclusive(state, async () => {
    SyncStateStore.start(state, new Date().toISOString());
    await persistSyncStates();
    try {
      try {
        const configs = await loadConfigs();
        const config = configs.find((candidate) => candidate.id === syncId);
        if (!config || !config.folderA || !config.folderB) {
          throw new Error(messenger.i18n.getMessage("errorNoFolders"));
        }

        const folders = await resolveAndPersistConfig(config, configs);
        return await syncFolders(syncId, folders.folderA, folders.folderB, config.direction || "both");
      } catch (err) {
        const result = { copiedAtoB: 0, copiedBtoA: 0, errors: [err.message], fatal: true };
        SyncStateStore.complete(state, result, err.message, new Date().toISOString());
        await appendLog(syncId, "error", `Fatal: ${err.message}`);
        await appendLog(syncId, "error", "Done: A→B 0, B→A 0, 1 error(s)");
        return result;
      } finally {
        setSyncProgress(state, null);
      }
    } finally {
      state.startedAt = null;
      setSyncProgress(state, null);
      // Persist the completed snapshot without releasing the in-memory lock;
      // runExclusive clears running after this operation returns.
      await persistSyncStates({ [syncId]: { running: false, startedAt: null } });
    }
  });
}

async function mutateConfigExclusive(syncId, operation) {
  const attempt = await SyncLock.runMutationExclusive(getSyncState(syncId), operation);
  if (!attempt.started) {
    return { error: messenger.i18n.getMessage("errorConfigLocked") };
  }
  return attempt.value;
}

messenger.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm.name.startsWith(ALARM_PREFIX)) return;

  const syncId = alarm.name.slice(ALARM_PREFIX.length);
  await startSyncExclusive(syncId);
});

async function updateFolderReferences(originalFolder, updatedFolder) {
  const configs = await loadConfigs();
  let changed = false;
  for (const config of configs) {
    for (const side of ["A", "B"]) {
      const stored = config[`folder${side}`];
      if (stored && (stored.id === originalFolder.id || stored.path === originalFolder.path)) {
        config[`folder${side}`] = FolderResolver.descriptor(updatedFolder);
        getSyncState(config.id).error = null;
        changed = true;
      }
    }
  }
  if (changed) await saveConfigs(configs);
}

messenger.folders.onMoved.addListener(updateFolderReferences);
messenger.folders.onRenamed.addListener(updateFolderReferences);
messenger.folders.onDeleted.addListener(async (deletedFolder) => {
  const configs = await loadConfigs();
  for (const config of configs) {
    for (const side of ["A", "B"]) {
      const stored = config[`folder${side}`];
      if (stored && (stored.id === deletedFolder.id || stored.path === deletedFolder.path)) {
        const state = getSyncState(config.id);
        state.error = folderResolutionError(side, "not-found");
        state.status = SyncStateStore.STATUS.FAILED;
      }
    }
  }
});

// --- Message handling (popup <-> background) ---

async function handleRuntimeMessage(message) {
  await syncStatesReady;
  await configAlarmsReady;
  switch (message.action) {
    case "getAccounts":
      try {
        return await getAccountsWithFolders();
      } catch (err) {
        console.error("FolderSync: failed to get accounts:", err);
        return [];
      }

    case "getConfigs": {
      const configs = await loadConfigs();
      try {
        return await refreshConfigFolderReferences(configs);
      } catch (err) {
        return configs;
      }
    }

    case "addConfig": {
      const configs = await loadConfigs();
      const newConfig = { ...message.config, id: generateId() };
      await validateConfig(newConfig);
      const nextConfigs = [...configs, newConfig];
      return await ConfigAlarmStore.saveWithAlarm(
        newConfig, configs, nextConfigs, configAlarmDependencies()
      );
    }

    case "updateConfig": {
      return await mutateConfigExclusive(message.config.id, async () => {
        const configs = await loadConfigs();
        const idx = configs.findIndex((c) => c.id === message.config.id);
        if (idx === -1) return { error: "Config not found" };
        await validateConfig(message.config);
        const nextConfigs = configs.slice();
        nextConfigs[idx] = message.config;
        await ConfigAlarmStore.saveWithAlarm(
          message.config, configs, nextConfigs, configAlarmDependencies()
        );
        return { ok: true };
      });
    }

    case "deleteConfig": {
      return await mutateConfigExclusive(message.syncId, async () => {
        const configs = await loadConfigs();
        const filtered = configs.filter((c) => c.id !== message.syncId);
        await saveConfigs(filtered);
        await stopAutoSync(message.syncId);
        await clearLog(message.syncId);
        syncStates.delete(message.syncId);
        await persistSyncStates();
        return { ok: true };
      });
    }

    case "startSync": {
      const syncId = message.syncId;
      const attempt = await startSyncExclusive(syncId);
      if (!attempt.started) {
        return { error: messenger.i18n.getMessage("errorSyncRunning") };
      }
      return attempt.value;
    }

    case "startAutoSync": {
      await startAutoSync(message.syncId, message.intervalMinutes);
      return { ok: true };
    }

    case "stopAutoSync": {
      await stopAutoSync(message.syncId);
      return { ok: true };
    }

    case "getStatus": {
      const configs = await loadConfigs();
      let accounts;
      try {
        accounts = await getAccountsWithFolders();
      } catch (err) {
        accounts = null;
      }
      const states = {};
      for (const config of configs) {
        const state = getSyncState(config.id);
        let folderError = null;
        if (accounts && !state.running) {
          try {
            await resolveConfigFolders(config, accounts);
          } catch (err) {
            folderError = err.message;
          }
        }
        states[config.id] = {
          ...state,
          status: folderError ? SyncStateStore.STATUS.FAILED : state.status,
          error: folderError || state.error,
          folderInvalid: !!folderError,
          autoSyncActive: await isAutoSyncActive(config.id),
        };
      }
      return states;
    }

    case "getLog":
      return await loadLog(message.syncId);

    case "clearLog":
      await clearLog(message.syncId);
      return { ok: true };

    default:
      return { error: `Unknown action: ${message.action}` };
  }
}

messenger.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleRuntimeMessage(message)
    .then(sendResponse)
    .catch((err) => {
      console.error("FolderSync: message handling failed:", err);
      sendResponse({ error: err.message });
    });

  return true;
});

console.log("FolderSync background script loaded");
