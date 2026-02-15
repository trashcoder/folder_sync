const ALARM_PREFIX = "foldersync-auto-sync-";

// Per-sync state: Map<syncId, { running, lastSync, lastResult, error }>
const syncStates = new Map();

function getSyncState(syncId) {
  if (!syncStates.has(syncId)) {
    syncStates.set(syncId, {
      running: false,
      lastSync: null,
      lastResult: null,
      error: null,
    });
  }
  return syncStates.get(syncId);
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

async function collectMessageIds(folder) {
  const map = new Map();
  for await (const msg of getMessages(folder)) {
    if (msg.headerMessageId) {
      map.set(msg.headerMessageId, msg.id);
    }
  }
  return map;
}

// --- Sync engine (bidirectional) ---

async function syncFolders(syncId, folderA, folderB, direction = "both") {
  const state = getSyncState(syncId);
  state.running = true;
  state.error = null;

  const result = {
    checkedA: 0,
    checkedB: 0,
    copiedAtoB: 0,
    copiedBtoA: 0,
    errors: [],
  };

  try {
    const [idsA, idsB] = await Promise.all([
      collectMessageIds(folderA),
      collectMessageIds(folderB),
    ]);

    result.checkedA = idsA.size;
    result.checkedB = idsB.size;

    // Copy A -> B
    if (direction === "both" || direction === "aToB") {
      const missingInB = [];
      for (const [messageId, tbId] of idsA) {
        if (!idsB.has(messageId)) {
          missingInB.push(tbId);
        }
      }

      if (missingInB.length > 0) {
        const batchSize = 50;
        for (let i = 0; i < missingInB.length; i += batchSize) {
          const batch = missingInB.slice(i, i + batchSize);
          try {
            await messenger.messages.copy(batch, folderB.id);
            result.copiedAtoB += batch.length;
          } catch (err) {
            result.errors.push(`A→B batch ${i}: ${err.message}`);
          }
        }
      }
    }

    // Copy B -> A
    if (direction === "both" || direction === "bToA") {
      const missingInA = [];
      for (const [messageId, tbId] of idsB) {
        if (!idsA.has(messageId)) {
          missingInA.push(tbId);
        }
      }

      if (missingInA.length > 0) {
        const batchSize = 50;
        for (let i = 0; i < missingInA.length; i += batchSize) {
          const batch = missingInA.slice(i, i + batchSize);
          try {
            await messenger.messages.copy(batch, folderA.id);
            result.copiedBtoA += batch.length;
          } catch (err) {
            result.errors.push(`B→A batch ${i}: ${err.message}`);
          }
        }
      }
    }
  } catch (err) {
    state.error = err.message;
    result.errors.push(err.message);
  }

  state.running = false;
  state.lastSync = new Date().toISOString();
  state.lastResult = result;

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
    const path = prefix ? `${prefix}/${folder.name}` : folder.name;
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
    await syncFolders(syncId, config.folderA, config.folderB, config.direction || "both");
  } catch (err) {
    state.error = err.message;
  }
});

// --- Message handling (popup <-> background) ---

messenger.runtime.onMessage.addListener(async (message) => {
  switch (message.action) {
    case "getAccounts":
      try {
        return await getAccountsWithFolders();
      } catch (err) {
        console.error("FolderSync: failed to get accounts:", err);
        return [];
      }

    case "getConfigs":
      return await loadConfigs();

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
      const result = await syncFolders(syncId, config.folderA, config.folderB, config.direction || "both");
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
      const states = {};
      for (const config of configs) {
        const state = getSyncState(config.id);
        states[config.id] = {
          ...state,
          autoSyncActive: await isAutoSyncActive(config.id),
        };
      }
      return states;
    }

    default:
      return { error: `Unknown action: ${message.action}` };
  }
});

console.log("FolderSync background script loaded");
