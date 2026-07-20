# FolderSync

A Thunderbird add-on that synchronizes email messages between folders across different accounts.

## Features

- **Bidirectional & one-way sync** — Choose between A ↔ B, A → B, or B → A synchronization
- **Multiple sync configurations** — Set up as many folder pairs as you need
- **Automatic sync** — Schedule periodic synchronization with configurable intervals (1–1440 minutes)
- **Deduplication** — Messages are matched by Message-ID and occurrence count. Messages without an ID use a metadata fingerprint (date, subject, sender, recipients, and size); identical fingerprints are compared by count.
- **Batch processing** — Large folders are handled efficiently with pagination and batch copying
- **Real-time status** — See sync progress, last sync time, and copied message counts
- **Localization** — English and German UI

## Installation

### From file

1. Download the latest `.xpi` file from the [Releases](../../releases) page
2. In Thunderbird, go to **Add-ons Manager** → **Extensions**
3. Click the gear icon → **Install Add-on From File…**
4. Select the downloaded `.xpi` file

### Build from source

```bash
git clone https://github.com/your-username/folder-sync.git
cd folder-sync
./build.sh
```

This creates a `foldersync-<version>.xpi` file ready for installation.

## Usage

1. Click the **FolderSync** icon in the Thunderbird toolbar
2. Click **Add new sync** to create a sync configuration
3. Select the source and destination accounts and folders
4. Choose the sync direction
5. Optionally enable automatic sync with your preferred interval
6. Click **Save**, then **Sync now** to run the first synchronization

## Requirements

- Thunderbird 128.0 or later

## Permissions

| Permission | Reason |
|---|---|
| `accountsRead` | List available email accounts |
| `messagesRead` | Read message headers for deduplication |
| `messagesMove` | Copy messages between folders |
| `storage` | Persist sync configurations |
| `alarms` | Schedule automatic synchronization |

## License

[MIT](LICENSE)
