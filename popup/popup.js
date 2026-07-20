const i18n = messenger.i18n.getMessage.bind(messenger.i18n);

const els = {
  // Views
  listView: document.getElementById("listView"),
  editView: document.getElementById("editView"),
  logView: document.getElementById("logView"),
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
  // Log view
  btnLogBack: document.getElementById("btnLogBack"),
  btnClearLog: document.getElementById("btnClearLog"),
  logViewTitle: document.getElementById("logViewTitle"),
  logEntries: document.getElementById("logEntries"),
  logEmpty: document.getElementById("logEmpty"),
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

  const manifest = messenger.runtime.getManifest();
  document.getElementById("versionInfo").textContent =
    `v${manifest.version} (Build ${typeof BUILD_NUMBER !== "undefined" ? BUILD_NUMBER : "?"})`;

  await loadAccounts();
  showListView();

  els.accountA.addEventListener("change", () => populateFolders("A"));
  els.accountB.addEventListener("change", () => populateFolders("B"));
  els.syncDirection.addEventListener("change", updateFolderAvailability);
  els.btnAdd.addEventListener("click", () => showEditView(null));
  els.btnSave.addEventListener("click", saveSync);
  els.btnCancel.addEventListener("click", showListView);
  els.btnLogBack.addEventListener("click", showListView);
  els.btnClearLog.addEventListener("click", clearCurrentLog);
});

// --- Views ---

async function showListView() {
  editingSyncId = null;
  els.listView.classList.remove("hidden");
  els.editView.classList.add("hidden");
  els.logView.classList.add("hidden");
  await renderSyncList();
  startStatusPolling();
}

async function showEditView(syncId) {
  stopStatusPolling();
  editingSyncId = syncId;
  els.listView.classList.add("hidden");
  els.editView.classList.remove("hidden");
  els.logView.classList.add("hidden");

  // Reset form
  els.syncName.value = "";
  els.accountA.value = "";
  setPlaceholderOption(els.folderA, "selectFolder");
  els.folderA.disabled = true;
  els.accountB.value = "";
  setPlaceholderOption(els.folderB, "selectFolder");
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
      els.syncDirection.value = config.direction || "both";
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
      els.autoSyncEnabled.checked = config.autoSyncEnabled || false;
      els.autoSyncInterval.value = config.autoSyncInterval || 5;
    }
  }
}

// --- Log view ---

let logSyncId = null;

async function showLogView(syncId, syncName) {
  stopStatusPolling();
  logSyncId = syncId;
  els.listView.classList.add("hidden");
  els.editView.classList.add("hidden");
  els.logView.classList.remove("hidden");
  els.logViewTitle.textContent = `${i18n("logTitle")}: ${syncName}`;
  await renderLog(syncId);
}

async function renderLog(syncId) {
  const entries = await messenger.runtime.sendMessage({ action: "getLog", syncId });
  els.logEntries.replaceChildren();
  if (!entries || entries.length === 0) {
    els.logEmpty.classList.remove("hidden");
    return;
  }
  els.logEmpty.classList.add("hidden");
  for (const entry of [...entries].reverse()) {
    const row = document.createElement("div");
    const level = entry.level === "error" ? "error" : "info";
    row.className = `log-entry log-entry-${level}`;
    const time = new Date(entry.ts).toLocaleString();

    const timeEl = document.createElement("span");
    timeEl.className = "log-ts";
    timeEl.textContent = time;

    const messageEl = document.createElement("span");
    messageEl.className = "log-msg";
    messageEl.textContent = entry.message;

    row.append(timeEl, messageEl);
    els.logEntries.appendChild(row);
  }
}

async function clearCurrentLog() {
  if (!logSyncId) return;
  await messenger.runtime.sendMessage({ action: "clearLog", syncId: logSyncId });
  await renderLog(logSyncId);
}

// --- Load accounts & folders ---

async function loadAccounts() {
  try {
    accountsData = await messenger.runtime.sendMessage({ action: "getAccounts" });
    if (!Array.isArray(accountsData)) {
      console.warn("FolderSync popup: account response is not an array");
      accountsData = [];
    }
  } catch {
    console.error("FolderSync: failed to load accounts");
    accountsData = [];
  }
}

function populateAccountDropdown(select, accounts) {
  setPlaceholderOption(select, "selectAccount");
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

  setPlaceholderOption(folderSelect, "selectFolder");

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
    opt.dataset.folderType = folder.type || "";
    opt.dataset.canAddMessages = String(folder.canAddMessages === true);
    folderSelect.appendChild(opt);
  }

  folderSelect.disabled = false;
  updateFolderAvailability();
}

function updateFolderAvailability() {
  const direction = els.syncDirection.value;
  for (const [side, select] of [["A", els.folderA], ["B", els.folderB]]) {
    const isDestination = direction === "both" ||
      (direction === "aToB" && side === "B") ||
      (direction === "bToA" && side === "A");
    for (const option of select.options) {
      if (!option.value) continue;
      option.disabled = isDestination && option.dataset.canAddMessages !== "true";
    }
    if (select.selectedOptions[0]?.disabled) select.value = "";
  }
}

function setPlaceholderOption(select, messageName) {
  const opt = document.createElement("option");
  opt.value = "";
  opt.textContent = i18n(messageName);
  select.replaceChildren(opt);
}

// --- Save sync config ---

async function saveSync() {
  const folderAOption = els.folderA.selectedOptions[0];
  const folderBOption = els.folderB.selectedOptions[0];

  if (!folderAOption?.value || !folderBOption?.value) {
    alert(i18n("alertSelectBothFolders"));
    return;
  }

  if (folderAOption.value === folderBOption.value) {
    alert(i18n("errorFoldersIdentical"));
    return;
  }

  const intervalText = els.autoSyncInterval.value.trim();
  const autoSyncInterval = Number(intervalText);
  if (intervalText === "" || !IntervalValidator.isValid(autoSyncInterval)) {
    alert(i18n("errorAutoSyncInterval"));
    els.autoSyncInterval.focus();
    return;
  }

  const config = {
    name: els.syncName.value.trim() || `${folderAOption.dataset.folderName} ↔ ${folderBOption.dataset.folderName}`,
    accountA: els.accountA.value,
    accountB: els.accountB.value,
    folderA: {
      id: folderAOption.value,
      name: folderAOption.dataset.folderName,
      path: folderAOption.textContent,
      type: folderAOption.dataset.folderType || null,
    },
    folderB: {
      id: folderBOption.value,
      name: folderBOption.dataset.folderName,
      path: folderBOption.textContent,
      type: folderBOption.dataset.folderType || null,
    },
    direction: els.syncDirection.value,
    autoSyncEnabled: els.autoSyncEnabled.checked,
    autoSyncInterval,
  };

  try {
    if (editingSyncId) {
      config.id = editingSyncId;
      const response = await messenger.runtime.sendMessage({ action: "updateConfig", config });
      if (response?.error) throw new Error(response.error);
    } else {
      const newConfig = await messenger.runtime.sendMessage({ action: "addConfig", config });
      if (newConfig?.error) throw new Error(newConfig.error);
    }
  } catch (err) {
    alert(err.message);
    return;
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
  els.syncList.replaceChildren();

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
  let statusClass = state.status || "idle";
  let statusText = i18n("statusReady");
  if (state.status === "running" || state.running) {
    statusClass = "running";
    statusText = i18n("statusSyncing");
  } else if (state.status === "success") {
    statusText = i18n("statusSuccess");
  } else if (state.status === "partialFailure") {
    statusText = i18n("statusPartialFailure");
  } else if (state.status === "failed" || state.error) {
    statusClass = "failed";
    statusText = i18n("statusFailed");
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

  const progress = getProgressView(state.progress);

  const header = document.createElement("div");
  header.className = "sync-card-header";

  const title = document.createElement("div");
  title.className = "sync-card-title";
  title.textContent = config.name || i18n("unnamed");
  header.appendChild(title);

  if (state.autoSyncActive) {
    const autoSyncBadge = document.createElement("span");
    autoSyncBadge.className = "badge badge-auto";
    autoSyncBadge.textContent = `Auto ${config.autoSyncInterval}min`;
    header.appendChild(autoSyncBadge);
  }

  const folders = document.createElement("div");
  folders.className = "sync-card-folders";

  const endpointA = document.createElement("span");
  endpointA.textContent = syncEndpoint(config, "A");

  const arrow = document.createElement("span");
  arrow.className = "sync-card-arrow";
  arrow.textContent = directionArrow(config.direction);

  const endpointB = document.createElement("span");
  endpointB.textContent = syncEndpoint(config, "B");
  folders.append(endpointA, arrow, endpointB);

  const status = document.createElement("div");
  status.className = "sync-card-status";

  const statusDot = document.createElement("span");
  statusDot.className = `status-dot ${statusClass}`;

  const statusTextEl = document.createElement("span");
  statusTextEl.className = "status-text";
  statusTextEl.textContent = statusText;
  status.append(statusDot, statusTextEl);

  const progressEl = document.createElement("div");
  progressEl.className = "sync-progress";
  progressEl.classList.toggle("hidden", !progress.visible);

  const progressRow = document.createElement("div");
  progressRow.className = "sync-progress-row";

  const progressText = document.createElement("span");
  progressText.className = "sync-progress-text";
  progressText.textContent = progress.text;

  const progressCount = document.createElement("span");
  progressCount.className = "sync-progress-count";
  progressCount.textContent = progress.count;
  progressRow.append(progressText, progressCount);

  const progressBar = document.createElement("div");
  progressBar.className = "sync-progress-bar";
  progressBar.setAttribute("role", "progressbar");
  progressBar.setAttribute("aria-valuemin", "0");
  progressBar.setAttribute("aria-valuemax", "100");
  progressBar.setAttribute("aria-valuenow", progress.percent.toString());

  const progressFill = document.createElement("div");
  progressFill.className = "sync-progress-fill";
  progressFill.style.width = `${progress.percent}%`;
  progressBar.appendChild(progressFill);
  progressEl.append(progressRow, progressBar);

  card.append(header, folders, status, progressEl);

  if (lastSyncText) {
    const lastSync = document.createElement("div");
    lastSync.className = "sync-card-meta";
    lastSync.textContent = `${i18n("lastSync")} ${lastSyncText}`;
    card.appendChild(lastSync);
  }

  if (resultText) {
    const result = document.createElement("div");
    result.className = "sync-card-meta";
    result.textContent = resultText;
    card.appendChild(result);
  }

  const actions = document.createElement("div");
  actions.className = "sync-card-actions";

  const syncButton = createButton("btn btn-primary btn-sm btn-sync", i18n("btnStartSync"));
  syncButton.disabled = !!state.running;

  const editButton = createButton("btn btn-secondary btn-sm btn-edit", i18n("btnEdit"));
  editButton.disabled = !!state.running;

  const logButton = createButton("btn btn-log btn-sm btn-log-view", i18n("btnLog"));
  if (state.status === "partialFailure" || state.status === "failed" || state.lastResult?.errors?.length > 0) {
    const errorBadge = document.createElement("span");
    errorBadge.className = "log-error-badge";
    errorBadge.textContent = "!";
    logButton.append(" ", errorBadge);
  }

  const deleteButton = createButton("btn btn-danger btn-sm btn-delete", i18n("btnDelete"));
  deleteButton.disabled = !!state.running;
  actions.append(syncButton, editButton, logButton, deleteButton);
  card.appendChild(actions);

  // Event listeners
  syncButton.addEventListener("click", () => startSync(config.id));
  editButton.addEventListener("click", () => showEditView(config.id));
  logButton.addEventListener("click", () => showLogView(config.id, config.name || i18n("unnamed")));
  deleteButton.addEventListener("click", () => deleteSync(config.id, config.name));

  return card;
}

function createButton(className, label) {
  const button = document.createElement("button");
  button.className = className;
  button.textContent = label;
  return button;
}

function syncEndpoint(config, side) {
  const accountId = side === "A" ? config.accountA : config.accountB;
  const folder = side === "A" ? config.folderA : config.folderB;
  const account = accountsData.find((item) => item.id === accountId);
  const accountLabel = account ? `${account.name} (${account.type})` : accountId || "?";
  return `${accountLabel} / ${folder?.path || folder?.name || "?"}`;
}

function getProgressView(progress) {
  if (!progress) {
    return {
      visible: false,
      text: "",
      count: "",
      percent: 0,
    };
  }

  if (progress.phase === "prepare") {
    return {
      visible: true,
      text: i18n("progressPreparing"),
      count: "",
      percent: 0,
    };
  }

  const total = Number(progress.total) || 0;
  const completed = Number(progress.completed) || 0;
  const remaining = Number(progress.remaining) || Math.max(total - completed, 0);
  const failed = Number(progress.failed) || 0;
  const percent = total > 0 ? Math.min(Math.round(((completed + failed) / total) * 100), 100) : 100;

  return {
    visible: true,
    text: progress.direction ? directionLabel(progress.direction) : i18n("statusSyncing"),
    count: progress.failed ? i18n("progressCountWithErrors", [completed, total, remaining, progress.failed]) : i18n("progressCount", [completed, total, remaining]),
    percent,
  };
}

function updateProgress(card, progress) {
  const progressEl = card.querySelector(".sync-progress");
  const textEl = card.querySelector(".sync-progress-text");
  const countEl = card.querySelector(".sync-progress-count");
  const barEl = card.querySelector(".sync-progress-bar");
  const fillEl = card.querySelector(".sync-progress-fill");
  if (!progressEl || !textEl || !countEl || !barEl || !fillEl) return;

  const view = getProgressView(progress);
  progressEl.classList.toggle("hidden", !view.visible);
  textEl.textContent = view.text;
  countEl.textContent = view.count;
  barEl.setAttribute("aria-valuenow", view.percent.toString());
  fillEl.style.width = `${view.percent}%`;
}

function directionLabel(direction) {
  if (direction === "aToB") return i18n("directionAtoBShort");
  if (direction === "bToA") return i18n("directionBtoAShort");
  return i18n("directionBothShort");
}

function directionArrow(direction) {
  if (direction === "aToB") return "→";
  if (direction === "bToA") return "←";
  return "↔";
}

// --- Sync actions ---

async function startSync(syncId) {
  // Update UI immediately
  const card = els.syncList.querySelector(`[data-sync-id="${syncId}"]`);
  if (card) {
    for (const btn of card.querySelectorAll(".btn-sync, .btn-edit, .btn-delete")) {
      btn.disabled = true;
    }
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
      for (const btn of card.querySelectorAll(".btn-sync, .btn-edit, .btn-delete")) {
        btn.disabled = false;
      }
    }
    return;
  }

  // Refresh entire list to show updated results
  await renderSyncList();
}

async function deleteSync(syncId, name) {
  if (!confirm(i18n("confirmDelete", [name]))) return;

  try {
    const response = await messenger.runtime.sendMessage({ action: "deleteConfig", syncId });
    if (response?.error) throw new Error(response.error);
  } catch (err) {
    alert(err.message);
  }
  await renderSyncList();
}

// --- Status polling ---

function startStatusPolling() {
  stopStatusPolling();
  statusPollTimer = setInterval(async () => {
    await renderSyncList();
  }, 2000);
}

function stopStatusPolling() {
  if (statusPollTimer) {
    clearInterval(statusPollTimer);
    statusPollTimer = null;
  }
}
