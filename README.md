# FolderSync

A Thunderbird add-on that synchronizes email messages between folders across different accounts.

## Features

- **Bidirectional & one-way sync** — Choose between A ↔ B, A → B, or B → A synchronization
- **Multiple sync jobs** — Set up any number of jobs, including several jobs for the same account pair
- **Multiple folder mappings per job** — Choose each source and target folder explicitly; one click or alarm runs every mapping in the job
- **Automatic sync** — Schedule periodic synchronization with configurable intervals (1–1440 minutes)
- **Deduplication** — Messages are matched by Message-ID and occurrence count. Messages without an ID use a metadata fingerprint (date, subject, sender, recipients, and size); identical fingerprints are compared by count.
- **Batch processing** — Large folders are handled efficiently with pagination and batch copying
- **Job and mapping status** — See sync progress, errors, last sync time, and copied message counts for each mapping
- **Localization** — English and German UI

## Installation

### From file

1. Download `foldersync-0.3.0.xpi` from the [releases page](https://github.com/trashcoder/folder_sync/releases)
2. In Thunderbird, go to **Add-ons Manager** → **Extensions**
3. Click the gear icon → **Install Add-on From File…**
4. Select the downloaded `.xpi` file

### Build from source

```bash
git clone https://github.com/trashcoder/folder_sync.git
cd folder_sync
./build.sh
```

This creates `build/foldersync-0.3.0.xpi` ready for installation.

## Usage

1. Click the **FolderSync** icon in the Thunderbird toolbar
2. Click **New Synchronization** to create a job
3. Select account A and account B once for the job
4. Choose a folder in each account for the first mapping; use **Add folder mapping** for more pairs
5. Choose the direction for the whole job
6. Optionally enable automatic sync with your preferred interval
7. Click **Save**, then **Start sync** to run all mappings

Each mapping is processed separately. The job card shows each mapping's copied-message counts and errors; the log identifies the affected mapping. A failed mapping does not hide counts from successful mappings. Existing 0.2.x configurations are converted to one-mapping jobs on upgrade, preserving their direction and automatic sync settings.

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
