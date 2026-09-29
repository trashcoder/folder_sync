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
  accountB: document.getElementById("accountB"),
  mappingRows: document.getElementById("mappingRows"),
  btnAddMapping: document.getElementById("btnAddMapping"),
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
  // Delete confirmation
  deleteDialog: document.getElementById("deleteDialog"),
  deleteDialogMessage: document.getElementById("deleteDialogMessage"),
  deleteDialogError: document.getElementById("deleteDialogError"),
  btnCancelDelete: document.getElementById("btnCancelDelete"),
  btnConfirmDelete: document.getElementById("btnConfirmDelete"),
};

let accountsData = [];
let editingSyncId = null; // null = new, string = editing existing
let pendingDelete = null;
const statusPoller = StatusPoller.create(refreshSyncStatuses, 2000);

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

  els.accountA.addEventListener("change", refreshMappingRows);
  els.accountB.addEventListener("change", refreshMappingRows);
  els.syncDirection.addEventListener("change", updateFolderAvailability);
  els.btnAddMapping.addEventListener("click", () => addMappingRow());
  els.btnAdd.addEventListener("click", () => showEditView(null));
  els.btnSave.addEventListener("click", saveSync);
  els.btnCancel.addEventListener("click", showListView);
  els.btnLogBack.addEventListener("click", showListView);
  els.btnClearLog.addEventListener("click", clearCurrentLog);
  els.btnCancelDelete.addEventListener("click", () => els.deleteDialog.close());
  els.btnConfirmDelete.addEventListener("click", confirmDeleteSync);
  els.deleteDialog.addEventListener("cancel", (event) => {
    if (pendingDelete?.inProgress) event.preventDefault();
  });
  els.deleteDialog.addEventListener("close", () => {
    const previousFocus = pendingDelete?.previousFocus;
    pendingDelete = null;
    if (previousFocus?.isConnected) previousFocus.focus();
  });
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
  els.accountB.value = "";
  els.mappingRows.replaceChildren();
  els.syncDirection.value = "both";
  els.autoSyncEnabled.checked = false;
  els.autoSyncInterval.value = "5";

  await loadAccounts(true);
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
      }
      if (config.accountB) {
        els.accountB.value = config.accountB;
      }
      for (const mapping of config.mappings || []) addMappingRow(mapping);
      els.autoSyncEnabled.checked = config.autoSyncEnabled || false;
      els.autoSyncInterval.value = config.autoSyncInterval || 5;
    }
  }
  if (!els.mappingRows.children.length) addMappingRow();
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

async function loadAccounts(refresh = false) {
  try {
    accountsData = await messenger.runtime.sendMessage({ action: "getAccounts", refresh });
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

function addMappingRow(mapping = null) {
  const row = document.createElement("div");
  row.className = "mapping-row";
  if (mapping?.id) row.dataset.mappingId = mapping.id;

  for (const side of ["A", "B"]) {
    const field = document.createElement("div");
    field.className = "field";
    const label = document.createElement("label");
    label.textContent = i18n(side === "A" ? "sourceFolder" : "targetFolder");
    const select = document.createElement("select");
    select.className = `mapping-folder-${side.toLowerCase()}`;
    label.appendChild(select);
    field.appendChild(label);
    row.appendChild(field);
    populateMappingFolders(select, side, mapping?.[`folder${side}`]);
  }
  const remove = createButton("btn btn-danger btn-sm", i18n("btnRemoveMapping"));
  remove.type = "button";
  remove.addEventListener("click", () => row.remove());
  row.appendChild(remove);
  els.mappingRows.appendChild(row);
  updateFolderAvailability();
}

function populateMappingFolders(select, side, selectedFolder = null) {
  const selectedId = selectedFolder?.id || "";
  const accountId = side === "A" ? els.accountA.value : els.accountB.value;
  const account = accountsData.find((item) => item.id === accountId);
  setPlaceholderOption(select, "selectFolder");
  select.disabled = !account;
  if (!account) return;
  for (const folder of account.folders) {
    const option = document.createElement("option");
    option.value = folder.id;
    option.textContent = folder.path;
    option.dataset.folderName = folder.name;
    option.dataset.folderSpecialUse = JSON.stringify(folder.specialUse || []);
    option.dataset.canAddMessages = String(folder.canAddMessages === true);
    select.appendChild(option);
  }
  if (selectedId && ![...select.options].some((option) => option.value === selectedId)) {
    const missing = document.createElement("option");
    missing.value = selectedId;
    missing.textContent = i18n("unavailableFolder", [selectedFolder.path || selectedFolder.name || selectedId]);
    missing.disabled = true;
    missing.dataset.unavailable = "true";
    missing.dataset.savedPath = selectedFolder.path || "";
    select.appendChild(missing);
  }
  select.value = selectedId;
  if (select.value !== selectedId) select.value = "";
}

function refreshMappingRows() {
  for (const row of els.mappingRows.children) {
    for (const side of ["A", "B"]) {
      const select = row.querySelector(`.mapping-folder-${side.toLowerCase()}`);
      populateMappingFolders(select, side, {
        id: select.value,
        path: select.selectedOptions[0]?.dataset.savedPath,
      });
    }
  }
  updateFolderAvailability();
}

function updateFolderAvailability() {
  const direction = els.syncDirection.value;
  for (const row of els.mappingRows.children) {
    for (const side of ["A", "B"]) {
      const select = row.querySelector(`.mapping-folder-${side.toLowerCase()}`);
      const isDestination = direction === "both" ||
        (direction === "aToB" && side === "B") ||
        (direction === "bToA" && side === "A");
      for (const option of select.options) {
        if (!option.value) continue;
        option.disabled = isDestination && option.dataset.canAddMessages !== "true";
      }
      if (select.selectedOptions[0]?.disabled && select.selectedOptions[0]?.dataset.unavailable !== "true") {
        select.value = "";
      }
    }
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
  const mappings = [];
  const seen = new Set();
  for (const row of els.mappingRows.children) {
    const folderAOption = row.querySelector(".mapping-folder-a").selectedOptions[0];
    const folderBOption = row.querySelector(".mapping-folder-b").selectedOptions[0];
    if (!folderAOption?.value || !folderBOption?.value || folderAOption.disabled || folderBOption.disabled) {
      alert(i18n("alertSelectBothFolders"));
      return;
    }
    if (folderAOption.value === folderBOption.value) {
      alert(i18n("errorFoldersIdentical"));
      return;
    }
    const key = JSON.stringify([folderAOption.value, folderBOption.value]);
    if (seen.has(key)) {
      alert(i18n("errorDuplicateMapping"));
      return;
    }
    seen.add(key);
    mappings.push({
      ...(row.dataset.mappingId ? { id: row.dataset.mappingId } : {}),
      folderA: selectedFolderDescriptor(folderAOption),
      folderB: selectedFolderDescriptor(folderBOption),
    });
  }
  if (!mappings.length) {
    alert(i18n("errorNoFolders"));
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
    name: els.syncName.value.trim() || `${mappings[0].folderA.name} ↔ ${mappings[0].folderB.name}`,
    accountA: els.accountA.value,
    accountB: els.accountB.value,
    mappings,
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

function selectedFolderDescriptor(option) {
  return {
    id: option.value,
    name: option.dataset.folderName,
    path: option.textContent,
    specialUse: JSON.parse(option.dataset.folderSpecialUse || "[]"),
  };
}

// --- Render sync list ---

async function renderSyncList() {
  const configs = await messenger.runtime.sendMessage({ action: "getConfigs" });
  const states = await messenger.runtime.sendMessage({ action: "getStatus" });

  els.emptyState.classList.toggle("hidden", configs.length > 0);
  els.syncList.replaceChildren();

  for (const config of configs) {
    const state = states[config.id] || {};
    const card = createSyncCard(config, state);
    els.syncList.appendChild(card);
  }
}

async function refreshSyncStatuses() {
  const states = await messenger.runtime.sendMessage({ action: "getStatus" });
  for (const card of els.syncList.querySelectorAll(".sync-card")) {
    updateSyncCardStatus(card, states[card.dataset.syncId] || {});
  }
}

function createSyncCard(config, state) {
  const card = document.createElement("div");
  card.className = "sync-card";
  card.dataset.syncId = config.id;

  const progress = getProgressView(state.progress);

  const header = document.createElement("div");
  header.className = "sync-card-header";

  const title = document.createElement("div");
  title.className = "sync-card-title";
  title.textContent = config.name || i18n("unnamed");
  header.appendChild(title);

  const autoSyncBadge = document.createElement("span");
  autoSyncBadge.className = "badge badge-auto hidden";
  autoSyncBadge.textContent = `Auto ${config.autoSyncInterval}min`;
  header.appendChild(autoSyncBadge);

  const folders = document.createElement("div");
  folders.className = "sync-card-mappings";
  for (const [index, mapping] of (config.mappings || []).entries()) {
    const pair = document.createElement("div");
    pair.className = "sync-card-folders";
    pair.dataset.mappingId = mapping.id;
    const endpointA = document.createElement("span");
    endpointA.textContent = syncEndpoint(config, mapping, "A");
    const arrow = document.createElement("span");
    arrow.className = "sync-card-arrow";
    arrow.textContent = directionArrow(config.direction);
    const endpointB = document.createElement("span");
    endpointB.textContent = syncEndpoint(config, mapping, "B");
    pair.append(endpointA, arrow, endpointB);
    const pairResult = document.createElement("div");
    pairResult.className = "sync-mapping-result";
    pairResult.dataset.mappingIndex = String(index);
    folders.append(pair, pairResult);
  }

  const status = document.createElement("div");
  status.className = "sync-card-status";

  const statusDot = document.createElement("span");
  statusDot.className = "status-dot";

  const statusTextEl = document.createElement("span");
  statusTextEl.className = "status-text";
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

  const lastSync = document.createElement("div");
  lastSync.className = "sync-card-meta sync-card-last-sync hidden";
  card.appendChild(lastSync);

  const result = document.createElement("div");
  result.className = "sync-card-meta sync-card-result hidden";
  card.appendChild(result);

  const actions = document.createElement("div");
  actions.className = "sync-card-actions";

  const syncButton = createButton("btn btn-primary btn-sm btn-sync", i18n("btnStartSync"));

  const editButton = createButton("btn btn-secondary btn-sm btn-edit", i18n("btnEdit"));

  const logButton = createButton("btn btn-log btn-sm btn-log-view", i18n("btnLog"));

  const deleteButton = createButton("btn btn-danger btn-sm btn-delete", i18n("btnDelete"));
  actions.append(syncButton, editButton, logButton, deleteButton);
  card.appendChild(actions);

  updateSyncCardStatus(card, state);

  // Event listeners
  syncButton.addEventListener("click", () => startSync(config.id));
  editButton.addEventListener("click", () => showEditView(config.id));
  logButton.addEventListener("click", () => showLogView(config.id, config.name || i18n("unnamed")));
  deleteButton.addEventListener("click", () => showDeleteDialog(config.id, config.name));

  return card;
}

function updateSyncCardStatus(card, state) {
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

  card.querySelector(".status-dot").className = `status-dot ${statusClass}`;
  card.querySelector(".status-text").textContent = statusText;
  card.querySelector(".badge-auto").classList.toggle("hidden", !state.autoSyncActive);
  updateProgress(card, state.progress);

  const lastSync = card.querySelector(".sync-card-last-sync");
  lastSync.classList.toggle("hidden", !state.lastSync);
  lastSync.textContent = state.lastSync
    ? `${i18n("lastSync")} ${new Date(state.lastSync).toLocaleString()}`
    : "";

  let resultText = "";
  if (state.lastResult) {
    resultText = `A→B: ${state.lastResult.copiedAtoB} | B→A: ${state.lastResult.copiedBtoA}`;
    if (state.lastResult.errors?.length > 0) {
      resultText += ` | ${i18n("errorCount", [state.lastResult.errors.length])}`;
    }
  }
  const result = card.querySelector(".sync-card-result");
  if (state.folderInvalid && state.error) resultText += ` | ${state.error}`;
  result.classList.toggle("hidden", !resultText);
  result.textContent = resultText;
  for (const pairResult of card.querySelectorAll(".sync-mapping-result")) {
    const index = Number(pairResult.dataset.mappingIndex);
    const mappingId = card.querySelectorAll(".sync-card-folders")[index]?.dataset.mappingId;
    const mapping = state.lastResult?.mappings?.find((item) => item.id === mappingId);
    if (state.running) {
      const current = state.progress?.mappingIndex === index + 1;
      pairResult.classList.toggle("hidden", !current);
      pairResult.textContent = current ? i18n("statusSyncing") : "";
      pairResult.classList.remove("mapping-error");
      continue;
    }
    pairResult.classList.toggle("hidden", !mapping);
    if (!mapping) continue;
    const status = mapping.errors?.length ? (mapping.fatal ? i18n("statusFailed") : i18n("statusPartialFailure")) : i18n("statusSuccess");
    pairResult.textContent = `${status} · A→B ${mapping.copiedAtoB} · B→A ${mapping.copiedBtoA}` +
      (mapping.errors?.length ? ` · ${mapping.errors[0]}` : "");
    pairResult.classList.toggle("mapping-error", !!mapping.errors?.length);
  }

  for (const button of card.querySelectorAll(".btn-sync, .btn-edit, .btn-delete")) {
    button.disabled = !!state.running;
  }

  const logButton = card.querySelector(".btn-log-view");
  const showErrorBadge = state.status === "partialFailure" || state.status === "failed" ||
    state.lastResult?.errors?.length > 0;
  let errorBadge = logButton.querySelector(".log-error-badge");
  if (showErrorBadge && !errorBadge) {
    errorBadge = document.createElement("span");
    errorBadge.className = "log-error-badge";
    errorBadge.textContent = "!";
    logButton.append(" ", errorBadge);
  } else if (!showErrorBadge && errorBadge) {
    errorBadge.remove();
  }
}

function createButton(className, label) {
  const button = document.createElement("button");
  button.className = className;
  button.textContent = label;
  return button;
}

function syncEndpoint(config, mapping, side) {
  const accountId = side === "A" ? config.accountA : config.accountB;
  const folder = side === "A" ? mapping.folderA : mapping.folderB;
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

  const mappingText = progress.mappingCount ? `${i18n("mappingProgress", [progress.mappingIndex, progress.mappingCount])} · ` : "";
  if (progress.phase === "prepare") {
    return {
      visible: true,
      text: mappingText + i18n("progressPreparing"),
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
    text: mappingText + (progress.direction ? directionLabel(progress.direction) : i18n("statusSyncing")),
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

function showDeleteDialog(syncId, name) {
  pendingDelete = {
    syncId,
    inProgress: false,
    previousFocus: document.activeElement,
  };
  els.deleteDialogMessage.textContent = i18n("confirmDelete", [name || i18n("unnamed")]);
  els.deleteDialogError.textContent = "";
  els.deleteDialogError.classList.add("hidden");
  els.btnCancelDelete.disabled = false;
  els.btnConfirmDelete.disabled = false;
  els.deleteDialog.showModal();
  els.btnConfirmDelete.focus();
}

async function confirmDeleteSync() {
  if (!pendingDelete || pendingDelete.inProgress) return;
  const syncId = pendingDelete.syncId;
  pendingDelete.inProgress = true;
  els.btnCancelDelete.disabled = true;
  els.btnConfirmDelete.disabled = true;
  try {
    const response = await messenger.runtime.sendMessage({ action: "deleteConfig", syncId });
    if (response?.error) throw new Error(response.error);
    els.deleteDialog.close();
    await renderSyncList();
  } catch (err) {
    if (!pendingDelete) return;
    pendingDelete.inProgress = false;
    els.btnCancelDelete.disabled = false;
    els.btnConfirmDelete.disabled = false;
    els.deleteDialogError.textContent = err.message;
    els.deleteDialogError.classList.remove("hidden");
    els.btnConfirmDelete.focus();
  }
}

// --- Status polling ---

function startStatusPolling() {
  statusPoller.start();
}

function stopStatusPolling() {
  statusPoller.stop();
}
