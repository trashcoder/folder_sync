const i18n = messenger.i18n.getMessage.bind(messenger.i18n);

const els = {
  // Views
  listView: document.getElementById("listView"),
  editView: document.getElementById("editView"),
  // List view
  btnAdd: document.getElementById("btnAdd"),
  syncList: document.getElementById("syncList"),
  emptyState: document.getElementById("emptyState"),
  // Edit view
  syncName: document.getElementById("syncName"),
  accountA: document.getElementById("accountA"),
  folderA: document.getElementById("folderA"),
  accountB: document.getElementById("accountB"),
  folderB: document.getElementById("folderB"),
  syncDirection: document.getElementById("syncDirection"),
  autoSyncEnabled: document.getElementById("autoSyncEnabled"),
  autoSyncInterval: document.getElementById("autoSyncInterval"),
  btnSave: document.getElementById("btnSave"),
  btnCancel: document.getElementById("btnCancel"),
};

let accountsData = [];
let editingSyncId = null; // null = new, string = editing existing
let statusPollTimer = null;

// --- i18n helper ---

function applyI18n() {
  for (const el of document.querySelectorAll("[data-i18n]")) {
    el.textContent = i18n(el.dataset.i18n);
  }
  for (const el of document.querySelectorAll("[data-i18n-placeholder]")) {
    el.placeholder = i18n(el.dataset.i18nPlaceholder);
  }
}

// --- Init ---

document.addEventListener("DOMContentLoaded", async () => {
  applyI18n();
  await loadAccounts();
  showListView();

  els.accountA.addEventListener("change", () => populateFolders("A"));
  els.accountB.addEventListener("change", () => populateFolders("B"));
  els.btnAdd.addEventListener("click", () => showEditView(null));
  els.btnSave.addEventListener("click", saveSync);
  els.btnCancel.addEventListener("click", showListView);
});

// --- Views ---

async function showListView() {
  editingSyncId = null;
  els.listView.classList.remove("hidden");
  els.editView.classList.add("hidden");
  await renderSyncList();
  startStatusPolling();
}

async function showEditView(syncId) {
  stopStatusPolling();
  editingSyncId = syncId;
  els.listView.classList.add("hidden");
  els.editView.classList.remove("hidden");

  // Reset form
  els.syncName.value = "";
  els.accountA.value = "";
  els.folderA.innerHTML = `<option value="">${i18n("selectFolder")}</option>`;
  els.folderA.disabled = true;
  els.accountB.value = "";
  els.folderB.innerHTML = `<option value="">${i18n("selectFolder")}</option>`;
  els.folderB.disabled = true;
  els.syncDirection.value = "both";
  els.autoSyncEnabled.checked = false;
  els.autoSyncInterval.value = "5";

  populateAccountDropdown(els.accountA, accountsData);
  populateAccountDropdown(els.accountB, accountsData);

  if (syncId) {
    const configs = await messenger.runtime.sendMessage({ action: "getConfigs" });
    const config = configs.find((c) => c.id === syncId);
    if (config) {
      els.syncName.value = config.name || "";
      if (config.accountA) {
        els.accountA.value = config.accountA;
        populateFolders("A");
        if (config.folderA) els.folderA.value = config.folderA.id;
      }
      if (config.accountB) {
        els.accountB.value = config.accountB;
        populateFolders("B");
        if (config.folderB) els.folderB.value = config.folderB.id;
      }
      els.syncDirection.value = config.direction || "both";
      els.autoSyncEnabled.checked = config.autoSyncEnabled || false;
      els.autoSyncInterval.value = config.autoSyncInterval || 5;
    }
  }
}

// --- Load accounts & folders ---

async function loadAccounts() {
  try {
    accountsData = await messenger.runtime.sendMessage({ action: "getAccounts" });
    console.log("FolderSync popup: received accounts:", JSON.stringify(accountsData));
    if (!Array.isArray(accountsData)) {
      console.warn("FolderSync popup: accountsData is not an array:", typeof accountsData, accountsData);
      accountsData = [];
    }
  } catch (err) {
    console.error("FolderSync: failed to load accounts:", err);
    accountsData = [];
  }
}

function populateAccountDropdown(select, accounts) {
  select.innerHTML = `<option value="">${i18n("selectAccount")}</option>`;
  for (const account of accounts) {
    const opt = document.createElement("option");
    opt.value = account.id;
    opt.textContent = `${account.name} (${account.type})`;
    select.appendChild(opt);
  }
}

function populateFolders(side) {
  const accountSelect = side === "A" ? els.accountA : els.accountB;
  const folderSelect = side === "A" ? els.folderA : els.folderB;
  const accountId = accountSelect.value;

  folderSelect.innerHTML = `<option value="">${i18n("selectFolder")}</option>`;

  if (!accountId) {
    folderSelect.disabled = true;
    return;
  }

  const account = accountsData.find((a) => a.id === accountId);
  if (!account) return;

  for (const folder of account.folders) {
    const opt = document.createElement("option");
    opt.value = folder.id;
    opt.textContent = folder.path;
    opt.dataset.folderId = folder.id;
    opt.dataset.folderName = folder.name;
    folderSelect.appendChild(opt);
  }

  folderSelect.disabled = false;
}

// --- Save sync config ---

async function saveSync() {
  const folderAOption = els.folderA.selectedOptions[0];
  const folderBOption = els.folderB.selectedOptions[0];

  if (!folderAOption?.value || !folderBOption?.value) {
    alert(i18n("alertSelectBothFolders"));
    return;
  }

  const config = {
    name: els.syncName.value.trim() || `${folderAOption.dataset.folderName} ↔ ${folderBOption.dataset.folderName}`,
    accountA: els.accountA.value,
    accountB: els.accountB.value,
    folderA: {
      id: folderAOption.value,
      name: folderAOption.dataset.folderName,
    },
    folderB: {
      id: folderBOption.value,
      name: folderBOption.dataset.folderName,
    },
    direction: els.syncDirection.value,
    autoSyncEnabled: els.autoSyncEnabled.checked,
    autoSyncInterval: parseInt(els.autoSyncInterval.value, 10) || 5,
  };

  if (editingSyncId) {
    config.id = editingSyncId;
    await messenger.runtime.sendMessage({ action: "updateConfig", config });

    // Update auto-sync alarm
    if (config.autoSyncEnabled) {
      await messenger.runtime.sendMessage({
        action: "startAutoSync",
        syncId: editingSyncId,
        intervalMinutes: config.autoSyncInterval,
      });
    } else {
      await messenger.runtime.sendMessage({ action: "stopAutoSync", syncId: editingSyncId });
    }
  } else {
    const newConfig = await messenger.runtime.sendMessage({ action: "addConfig", config });

    // Start auto-sync if enabled
    if (config.autoSyncEnabled && newConfig.id) {
      await messenger.runtime.sendMessage({
        action: "startAutoSync",
        syncId: newConfig.id,
        intervalMinutes: config.autoSyncInterval,
      });
    }
  }

  showListView();
}

// --- Render sync list ---

async function renderSyncList() {
  const [configs, states] = await Promise.all([
    messenger.runtime.sendMessage({ action: "getConfigs" }),
    messenger.runtime.sendMessage({ action: "getStatus" }),
  ]);

  els.emptyState.classList.toggle("hidden", configs.length > 0);
  els.syncList.innerHTML = "";

  for (const config of configs) {
    const state = states[config.id] || {};
    const card = createSyncCard(config, state);
    els.syncList.appendChild(card);
  }
}

function createSyncCard(config, state) {
  const card = document.createElement("div");
  card.className = "sync-card";
  card.dataset.syncId = config.id;

  // Status class
  let statusClass = "idle";
  let statusText = i18n("statusReady");
  if (state.running) {
    statusClass = "running";
    statusText = i18n("statusSyncing");
  } else if (state.error) {
    statusClass = "error";
    statusText = state.error;
  }

  // Last sync info
  let lastSyncText = "";
  if (state.lastSync) {
    lastSyncText = new Date(state.lastSync).toLocaleString();
  }

  // Result info
  let resultText = "";
  if (state.lastResult) {
    const r = state.lastResult;
    resultText = `A→B: ${r.copiedAtoB} | B→A: ${r.copiedBtoA}`;
    if (r.errors && r.errors.length > 0) {
      resultText += ` | ${i18n("errorCount", [r.errors.length])}`;
    }
  }

  // Auto-sync badge
  const autoSyncBadge = state.autoSyncActive
    ? `<span class="badge badge-auto">Auto ${config.autoSyncInterval}min</span>`
    : "";

  card.innerHTML = `
    <div class="sync-card-header">
      <div class="sync-card-title">${escapeHtml(config.name || i18n("unnamed"))}</div>
      ${autoSyncBadge}
    </div>
    <div class="sync-card-folders">${escapeHtml(config.folderA?.name || "?")} ${directionArrow(config.direction)} ${escapeHtml(config.folderB?.name || "?")}</div>
    <div class="sync-card-status">
      <span class="status-dot ${statusClass}"></span>
      <span class="status-text">${escapeHtml(statusText)}</span>
    </div>
    ${lastSyncText ? `<div class="sync-card-meta">${i18n("lastSync")} ${lastSyncText}</div>` : ""}
    ${resultText ? `<div class="sync-card-meta">${escapeHtml(resultText)}</div>` : ""}
    <div class="sync-card-actions">
      <button class="btn btn-primary btn-sm btn-sync" ${state.running ? "disabled" : ""}>${i18n("btnStartSync")}</button>
      <button class="btn btn-secondary btn-sm btn-edit">${i18n("btnEdit")}</button>
      <button class="btn btn-danger btn-sm btn-delete">${i18n("btnDelete")}</button>
    </div>
  `;

  // Event listeners
  card.querySelector(".btn-sync").addEventListener("click", () => startSync(config.id));
  card.querySelector(".btn-edit").addEventListener("click", () => showEditView(config.id));
  card.querySelector(".btn-delete").addEventListener("click", () => deleteSync(config.id, config.name));

  return card;
}

function directionArrow(direction) {
  if (direction === "aToB") return "→";
  if (direction === "bToA") return "←";
  return "↔";
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// --- Sync actions ---

async function startSync(syncId) {
  // Update UI immediately
  const card = els.syncList.querySelector(`[data-sync-id="${syncId}"]`);
  if (card) {
    const btn = card.querySelector(".btn-sync");
    btn.disabled = true;
    const statusDot = card.querySelector(".status-dot");
    const statusText = card.querySelector(".status-text");
    statusDot.className = "status-dot running";
    statusText.textContent = i18n("statusSyncing");
  }

  const result = await messenger.runtime.sendMessage({ action: "startSync", syncId });

  if (result.error) {
    if (card) {
      const statusDot = card.querySelector(".status-dot");
      const statusText = card.querySelector(".status-text");
      statusDot.className = "status-dot error";
      statusText.textContent = result.error;
      const btn = card.querySelector(".btn-sync");
      btn.disabled = false;
    }
    return;
  }

  // Refresh entire list to show updated results
  await renderSyncList();
}

async function deleteSync(syncId, name) {
  if (!confirm(i18n("confirmDelete", [name]))) return;

  await messenger.runtime.sendMessage({ action: "deleteConfig", syncId });
  await renderSyncList();
}

// --- Status polling ---

function startStatusPolling() {
  stopStatusPolling();
  statusPollTimer = setInterval(async () => {
    const states = await messenger.runtime.sendMessage({ action: "getStatus" });
    // Update status dots and texts for each card without full re-render
    for (const [syncId, state] of Object.entries(states)) {
      const card = els.syncList.querySelector(`[data-sync-id="${syncId}"]`);
      if (!card) continue;

      const statusDot = card.querySelector(".status-dot");
      const statusText = card.querySelector(".status-text");
      const btn = card.querySelector(".btn-sync");

      if (state.running) {
        statusDot.className = "status-dot running";
        statusText.textContent = i18n("statusSyncing");
        btn.disabled = true;
      } else if (state.error) {
        statusDot.className = "status-dot error";
        statusText.textContent = state.error;
        btn.disabled = false;
      } else {
        statusDot.className = "status-dot idle";
        statusText.textContent = i18n("statusReady");
        btn.disabled = false;
      }
    }
  }, 2000);
}

function stopStatusPolling() {
  if (statusPollTimer) {
    clearInterval(statusPollTimer);
    statusPollTimer = null;
  }
}
