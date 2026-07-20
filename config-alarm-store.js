(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ConfigAlarmStore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  async function setAlarm(config, deps) {
    if (config.autoSyncEnabled) {
      await deps.createAlarm(config.id, config.autoSyncInterval || 5);
    } else {
      await deps.clearAlarm(config.id);
    }
  }

  async function restoreAlarm(syncId, previousAlarm, deps) {
    if (previousAlarm) {
      await deps.createAlarm(syncId, previousAlarm.periodInMinutes);
    } else {
      await deps.clearAlarm(syncId);
    }
  }

  async function saveWithAlarm(config, previousConfigs, nextConfigs, deps) {
    const previousAlarm = await deps.getAlarm(config.id);
    try {
      await setAlarm(config, deps);
      await deps.saveConfigs(nextConfigs);
      return config;
    } catch (error) {
      const rollbackErrors = [];
      try {
        await deps.saveConfigs(previousConfigs);
      } catch (rollbackError) {
        rollbackErrors.push(`configuration rollback failed: ${rollbackError.message}`);
      }
      try {
        await restoreAlarm(config.id, previousAlarm, deps);
      } catch (rollbackError) {
        rollbackErrors.push(`alarm rollback failed: ${rollbackError.message}`);
      }
      const suffix = rollbackErrors.length ? ` (${rollbackErrors.join("; ")})` : "";
      throw new Error(`${error.message}${suffix}`);
    }
  }

  async function reconcile(configs, deps) {
    const alarms = await deps.getAllAlarms();
    const existing = new Map();
    for (const alarm of alarms) {
      const syncId = deps.syncIdFromAlarm(alarm.name);
      if (syncId) existing.set(syncId, alarm);
    }

    const configuredIds = new Set(configs.map((config) => config.id));
    for (const config of configs) {
      const alarm = existing.get(config.id);
      const interval = config.autoSyncInterval || 5;
      if (config.autoSyncEnabled) {
        if (!alarm || alarm.periodInMinutes !== interval) {
          await deps.createAlarm(config.id, interval);
        }
      } else if (alarm) {
        await deps.clearAlarm(config.id);
      }
    }

    for (const syncId of existing.keys()) {
      if (!configuredIds.has(syncId)) await deps.clearAlarm(syncId);
    }
  }

  return { saveWithAlarm, reconcile };
});
