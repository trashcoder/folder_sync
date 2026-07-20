const ALARM_PREFIX = "foldersync-auto-sync-";

// Per-sync state: Map<syncId, { running, lastSync, lastResult, error, progress }>
const syncStates = new Map();

function getSyncState(syncId) {
  if (!syncStates.has(syncId)) {
    syncStates.set(syncId, {
      running: false,
      lastSync: null,
      lastResult: null,
      error: null,
      progress: null,
    });
  }
  return syncStates.get(syncId);
}

function setSyncProgress(state, progress) {
  state.progress = progress;
}

function updateCopyProgress(state, direction, completed, total) {
  setSyncProgress(state, {
    phase: "copy",
    direction,
    completed,
    total,
    remaining: Math.max(total - completed, 0),
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
  state.running = true;
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
          await messenger.messages.copy(batch, folderB.id);
          result.copiedAtoB += batch.length;
          totalCopied += batch.length;
          updateCopyProgress(state, "aToB", totalCopied, totalToCopy);
        } catch (err) {
          const msg = `A→B batch ${i}: ${err.message}`;
          result.errors.push(msg);
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
          await messenger.messages.copy(batch, folderA.id);
          result.copiedBtoA += batch.length;
          totalCopied += batch.length;
          updateCopyProgress(state, "bToA", totalCopied, totalToCopy);
        } catch (err) {
          const msg = `B→A batch ${i}: ${err.message}`;
          result.errors.push(msg);
          await appendLog(syncId, "error", msg);
        }
      }
    }
  } catch (err) {
    state.error = err.message;
    result.errors.push(err.message);
    await appendLog(syncId, "error", `Fatal: ${err.message}`);
  }

  state.running = false;
  state.lastSync = new Date().toISOString();
  state.lastResult = result;
  setSyncProgress(state, null);

  const summary = `Done: A→B ${result.copiedAtoB}, B→A ${result.copiedBtoA}` +
    (result.errors.length ? `, ${result.errors.length} error(s)` : "");
  await appendLog(syncId, result.errors.length > 0 ? "error" : "info", summary);

  return result;
}

// --- Account & folder helpers ---

async function getAccountsWithFolders() {
  const accounts = await messenger.accounts.list(true);
  console.log("FolderSync: raw accounts:", JSON.stringify(accounts.map(a => ({ id: a.id, name: a.name, type: a.type, hasRootFolder: !!a.rootFolder }))));
  return accounts
    .filter((account) => account.type !== "none" && account.type !== "nntp")
    .map((account) => ({
      id: account.id,
      name: account.name,
      type: account.type,
      folders: flattenFolders(account.rootFolder?.subFolders || []),
    }));
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
  return resolved;
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
    Object.assign(config, resolved);
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
        if (JSON.stringify(config[key]) !== JSON.stringify(resolved[key])) {
          config[key] = resolved[key];
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

messenger.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm.name.startsWith(ALARM_PREFIX)) return;

  const syncId = alarm.name.slice(ALARM_PREFIX.length);
  const state = getSyncState(syncId);
  if (state.running) return;

  const configs = await loadConfigs();
  const config = configs.find((c) => c.id === syncId);
  if (!config || !config.folderA || !config.folderB) return;

  try {
    const folders = await resolveAndPersistConfig(config, configs);
    await syncFolders(syncId, folders.folderA, folders.folderB, config.direction || "both");
  } catch (err) {
    state.error = err.message;
  }
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
        getSyncState(config.id).error = folderResolutionError(side, "not-found");
      }
    }
  }
});

// --- Message handling (popup <-> background) ---

async function handleRuntimeMessage(message) {
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
      configs.push(newConfig);
      await saveConfigs(configs);
      return newConfig;
    }

    case "updateConfig": {
      const configs = await loadConfigs();
      const idx = configs.findIndex((c) => c.id === message.config.id);
      if (idx === -1) return { error: "Config not found" };
      configs[idx] = message.config;
      await saveConfigs(configs);
      return { ok: true };
    }

    case "deleteConfig": {
      const configs = await loadConfigs();
      const filtered = configs.filter((c) => c.id !== message.syncId);
      await saveConfigs(filtered);
      await stopAutoSync(message.syncId);
      await clearLog(message.syncId);
      syncStates.delete(message.syncId);
      return { ok: true };
    }

    case "startSync": {
      const syncId = message.syncId;
      const state = getSyncState(syncId);
      if (state.running) {
        return { error: messenger.i18n.getMessage("errorSyncRunning") };
      }
      const configs = await loadConfigs();
      const config = configs.find((c) => c.id === syncId);
      if (!config || !config.folderA || !config.folderB) {
        return { error: messenger.i18n.getMessage("errorNoFolders") };
      }
      let folders;
      try {
        folders = await resolveAndPersistConfig(config, configs);
      } catch (err) {
        state.error = err.message;
        await appendLog(syncId, "error", err.message);
        return { error: err.message };
      }
      const result = await syncFolders(syncId, folders.folderA, folders.folderB, config.direction || "both");
      return result;
    }

    case "startAutoSync": {
      await startAutoSync(message.syncId, message.intervalMinutes || 5);
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
