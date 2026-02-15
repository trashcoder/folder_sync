const i18n = messenger.i18n.getMessage.bind(messenger.i18n);

function applyI18n() {
  for (const el of document.querySelectorAll("[data-i18n]")) {
    el.textContent = i18n(el.dataset.i18n);
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  applyI18n();

  const manifest = messenger.runtime.getManifest();
  document.getElementById("version").textContent = `v${manifest.version}`;
});
