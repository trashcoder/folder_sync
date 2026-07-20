# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

FolderSync is a Thunderbird add-on (Manifest V3) that synchronizes email messages between folders across different accounts. It uses the MailExtension API (`messenger.*`), not the standard WebExtension API (`browser.*` / `chrome.*`).

## Build

```bash
./build.sh
```

Outputs `build/foldersync-<version>.xpi`. The version is read from `manifest.json`. No dependencies or package manager — plain JavaScript only.

To install: in Thunderbird, go to Add-ons Manager → Extensions → gear icon → "Install Add-on From File…" and select the `.xpi`.

## Architecture

The extension follows the standard background/popup split:

- **`background.js`** — the sync engine. Runs persistently in the background. Owns all state (`syncStates` Map), config persistence (`messenger.storage.local`), and alarm scheduling. Exposes functionality exclusively via `messenger.runtime.onMessage`.
- **`popup/popup.js`** — the toolbar popup UI. Stateless: fetches everything from the background on load. Two views: list view (shows all sync configs with status) and edit view (create/update a config). Polls background every 2 seconds for status updates while the list view is open.
- **`options/options.html`** — minimal options page that only shows the extension version.
- **`_locales/`** — i18n strings in `en-US` and `de`. All UI strings go through `messenger.i18n.getMessage`. HTML elements use `data-i18n` attributes; `applyI18n()` applies them on load.

### Message protocol (popup → background)

All communication uses `messenger.runtime.sendMessage`. Supported actions:

| Action | Description |
|---|---|
| `getAccounts` | Returns accounts with flattened folder trees (excludes `none`/`nntp` types) |
| `getConfigs` | Returns all sync configs from storage |
| `addConfig` | Adds a new config, returns it with generated ID |
| `updateConfig` | Updates existing config by ID |
| `deleteConfig` | Removes config, clears alarm, deletes state |
| `startSync` | Runs sync immediately for a given `syncId` |
| `startAutoSync` | Creates a periodic alarm for a sync |
| `stopAutoSync` | Clears the alarm for a sync |
| `getStatus` | Returns `syncStates` + `autoSyncActive` for all configs |

### Sync logic

Messages are grouped by `headerMessageId` and occurrence count. For messages without a Message-ID, `message-matcher.js` builds a stable metadata fingerprint. `collectMessagesByIdentity` pages through all messages in a folder (using `messenger.messages.continueList` for pagination), and surplus occurrences are copied in batches of 50 via `messenger.messages.copy`.

Directions: `"both"` (bidirectional), `"aToB"`, `"bToA"`.

### Config schema (stored in `messenger.storage.local` as `syncConfigs` array)

```js
{
  id: string,           // generated: Date.now().toString(36) + random
  name: string,
  accountA: string,     // account ID
  accountB: string,
  folderA: { id, name },
  folderB: { id, name },
  direction: "both" | "aToB" | "bToA",
  autoSyncEnabled: boolean,
  autoSyncInterval: number  // minutes
}
```

A one-time migration runs on `loadConfigs` to convert the old single `syncConfig` key to the new `syncConfigs` array format.

### Alarms

Auto-sync uses `messenger.alarms` with names prefixed `foldersync-auto-sync-<syncId>`. The alarm listener in `background.js` skips execution if a sync is already running for that ID.
