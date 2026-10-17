# Operating your installation

## Files and processes

On Linux, the installation is self-contained except for one generated user service in `~/.config/systemd/user/idsl-latex-<folder-hash>.service`. `./labtex status` shows its name. The folder hash allows separate installations to use separate services; give each a different port.

| Location | Contents | Public? |
| --- | --- | --- |
| Tracked source files | App, installer, tests, documentation | Yes |
| `.local/native.json` | Linux paths, port, saved exposure mode | No |
| `.local/local.json`, `.local/local.pid`, `.local/local.lock` | Mac runner settings and process state | No |
| `.local/bin/typst`, `.local/bin/tectonic`, `.local/bin/tinymist`, `.local/compiler-home/` | Mac PDF compilers, live language/preview service, and package caches | Not included in source releases |
| `.local/builds/` | Temporary Mac compiler input/output and live-session mirrors | No |
| `.local/setup-token` | Bootstrap token, invalid after first account | No |
| `.local/tex/`, `.local/tex-bundle/` | Downloaded compiler and offline bundle | Not included in source releases |
| `.local/bin/cloudflared` | Optional tunnel connector | Not included in source releases |
| `.local/url`, `.local/*.log` | Current endpoint and private operational logs | No |
| `data/labtex.sqlite3*` | Accounts, password hashes, token hashes, projects, history, PDFs | No |
| `.local/backups/` | Private database backups | No |

On Mac, `./labtex start` starts a background process bound to loopback; `./labtex stop` stops it, and a machine restart requires starting it again. There is no generated system service. Appearance and explorer-view preferences are stored in the browser, not in the installation configuration.

Editable Typst projects start account-scoped Tinymist workers on Mac. Live mirrors are temporary; `.typ`/`.tex` files and assets remain stored in SQLite. Leaving the editor, signing out, idle expiry, and server shutdown release workers. After an unclean process/OS crash, stop the app before removing abandoned `labtex-live-*` folders under `.local/builds/`; these are not the authoritative project storage. An existing installation needs `./labtex setup` and a restart to install/enable Tinymist. Set `LABTEX_TYPST_LIVE=0` when starting to use only the PDF compiler.

On Linux, the supervisor starts the optional connector and a sandboxed backend. Compilation starts a nested sandbox with its own network namespace. Resource limits apply to the whole service process group. A supervisor/connector failure causes systemd to restart the service, which generates a new Quick Tunnel hostname.

Logs are private and may include file paths or endpoint details. `./labtex logs` prints their last 50 lines. Review disk usage periodically. Log files are not a security audit trail; web logs are not automatically rotated during a running service. Stop the service before archiving/truncating logs. Keep archives under `.local/` or another private directory, never in public source folders.

## Back up

```bash
mkdir -p .local/backups
python3 manage.py backup ".local/backups/labtex-$(date +%Y%m%d-%H%M%S).sqlite3"
```

The command uses SQLite's online backup API for consistency and creates the result with private permissions. Copy it to protected off-host storage. The database includes authentication state, so encrypt backups at rest where appropriate. The compiler bundle can be downloaded again; the database cannot.

## Project source backups on GitHub

Project owners configure individual source backups from **Backup** inside the editor. The editor shows inclusion and last-snapshot status for the shared repository and can update only the open document there; all-project actions and shared repository settings live in the project explorer. Shared snapshot records remain independent of separate-repository settings. A shared repository uses `projects/PROJECT NAME/` (numbered for duplicate names); a separate repository uses its root. Existing ID-named folders migrate on their next backup, and project renames move the managed snapshot at that time. GitHub snapshots retain source/assets and a project manifest, while the SQLite backup above retains accounts, history, membership, and PDFs. Both may be useful. Remembered tokens use macOS Keychain or private Linux credential files, separately from SQLite. Moving an installation or restoring only its database may require saving the token again. Use **Forget saved token** before removing an installation; revoke unwanted tokens on GitHub as well. Automatic GitHub backups stop after closing/reloading the tab until enabled again; saved tokens remain reusable. See [GitHub backup and restoration steps](LOCAL.md#github-backups).

The Typst sample is a regular option under **More templates**. Each chosen copy is private to its owner and counts toward the project limit. Home visits create nothing automatically and preserve existing samples. Deleting a copy does not recreate it.

## Restore

Stop the service, retain the current database for rollback, and restore a trusted backup. Use the actual path to your backup instead of the example:

```bash
./labtex stop
mkdir -p .local/pre-restore
mv data/labtex.sqlite3* .local/pre-restore/
cp /PRIVATE/BACKUP/labtex.sqlite3 data/labtex.sqlite3
chmod 600 data/labtex.sqlite3
./labtex start
```

Use a new, empty rollback directory for each restore. Do not restore over an active database or mix an old main database with newer `-wal` / `-shm` files. Restoring also restores accounts, invitation hashes, and sessions from the backup; revoke access or reset passwords if that state is no longer trusted.

## Upgrade a Git checkout

Review the release notes and back up first. Keep runtime directories in place:

```bash
./labtex stop
git pull --ff-only
./labtex setup
./labtex start
./labtex doctor
```

If you made local source changes, resolve them deliberately before updating. Setup preserves saved settings and verifies/reuses cached dependencies. A new dependency pin may require another download. For a ZIP installation, stop the app, back it up, and replace only source files with the new release; retain the existing private `data/` and `.local/` directories. Never overwrite private configuration with someone else's installation files.

## Account recovery

```bash
python3 manage.py reset-password member@example.org
```

The operator enters the new password twice through a hidden prompt. Existing sessions are revoked. Removing an address from the approved list blocks login but does not delete its account or papers. The first account remains the admission administrator; changing administrators is not exposed in this release's UI.

## Uninstall

On Mac, stop with `./labtex stop`, back up the database, and remove the checkout when no longer needed. The remaining commands are Linux-only:

```bash
./labtex uninstall-service
```

This stops/disables this installation and removes its unit. It does not delete accounts, source files, backups, or compiler downloads. Back up before manually removing the folder. If lingering was enabled only for this application, the host administrator can disable it after checking that no other user services rely on it.
