# Development and release validation

The runtime is Python's standard library plus plain browser JavaScript. There is no production npm/pip dependency tree. A vendored, checksum-verified Mozilla PDF.js 6.4.299 bundle renders LaTeX PDFs locally; its license and release/file hashes are in `web/vendor/pdfjs/`. On Mac, the verified Tinymist executable provides a persistent compiler, LSP, and bundled live renderer. Linux compiler and tunnel downloads are pinned in `deploy/dependencies.json`; Mac compilers are pinned in `deploy/local-dependencies.json`. See [local development](LOCAL.md) for the Mac runner and isolated browser suite.

## Lean development and release review

Follow [AGENTS.md](../AGENTS.md) for every change. Before each release, perform the full runtime audit and measured checks in [PERFORMANCE.md](PERFORMANCE.md). `python3 tests/run_browser.py --performance` uses fictional large-project fixtures and enforces idle/network/rendering budgets; the GitHub workflow runs it independently of native compiler tests.

## Automated tests

After setup:

```bash
./labtex test
```

Tests use temporary databases and fictional addresses under `example.test`. They cover authentication, invitation expiry/reuse/revocation, independent projects, project permissions, concurrent-save conflicts, ZIP traversal, history quotas, request limits, per-client throttling, PDF build success/failure, and private/idempotent Typst sample creation with quota enforcement. Project-folder tests check per-user isolation, viewer organization, atomic creation, persistence, empty-only deletion, name validation, cycle/depth limits, quotas, and placement cleanup. Sandbox tests check that private files and environment values are hidden, system mounts are read-only, and the compiler has no external network.

The installer also checks namespaces and compiles a real sample through the offline compiler. `./labtex doctor` repeats these checks. Never bypass failed isolation checks for a shared deployment.

CI runs the backend/installer tests with a distribution TeX Live installation. Native sandbox tests skip there because the production bundle is not configured. Full native installation, nested compilation, and browser tests must also pass on a disposable Linux installation before a release. Mac validation does not establish that Linux sandbox installation is working.

## Browser regression test

`python3 tests/run_browser.py --source-search` checks current-file scope without project-source requests, highlights, wrapped keyboard navigation, regex/literal replacement, undo, unsaved drafts, folding, split panes, the separate project-search panel and mobile layout.

`python3 tests/run_browser.py --workspace-tools` covers regex replacement and recovery, lexical outlines, tab/cursor persistence, linked and separate split buffers, smart keys/completions, bibliography CRUD/DOI previews/missing keys, selective GitHub diff review and independent restore, and mobile bounds. DOI/GitHub UI tests use mocked registry responses and fictional local projects. `tests/test_project_tools.py` verifies real HTTP permissions, atomic rollback, checkpoints, revision conflicts, immutable Git blob verification, scope isolation, unsafe paths and DOI registry validation. The native Tinymist suite verifies split-pane memory edits and completions through the existing live worker.

`project_changes.py` applies revision-checked batches inside the caller's SQLite transaction, preserves file history, and creates bounded ZIP checkpoints. `github_restore.py` reads immutable Git trees/blobs and source diffs; server-owned review plans are account/project scoped, expire in 15 minutes, and use a bounded 128 MB memory cache. Apply never trusts source content or revisions supplied by the browser. The selected snapshot is already pinned; concurrent local writes invalidate the complete plan. GitHub restore performs no remote mutations. `doi_metadata.py` contacts only fixed registry API hosts with redirects disabled and a 256 KiB response limit.

`python3 tests/run_browser.py --collaboration` launches two independent HTTP apps/databases/accounts against a versioned in-memory GitHub API. It checks connecting/joining, each installation's stored credential, reloads, disjoint merges, explicit manual conflicts, stale-head rejection and draft recovery, and mobile layout. `test_github_collaboration.py` also checks adds/deletes/main changes, binary version selection/downloads, root-repository exclusion of unlisted files, collision protection, expiry, ownership and concurrent local/remote writes. No real repository or Keychain entry is used.

`github_collaboration.py` stores each link and compressed baseline in private SQLite. Reviews bind immutable base/local/remote source to the account, project, local revision and Git commit for 15 minutes, with at most four reviews and a 192 MiB aggregate content budget. Source merges use conservative line-based three-way comparison; binary/large/overlapping edits require explicit resolution. Sync validates the local transaction before network writes, publishes only manifest-owned paths with a non-forced ref update, then rechecks local revision/connection before applying atomically with a recovery checkpoint. A local edit during upload retains the draft and old baseline for a fresh review even if the remote commit succeeded. The original remote project ID stays stable across independent local IDs. Collaboration-marked manifests reject ordinary snapshot overwrites; bulk backups skip linked projects.

`python3 tests/run_browser.py --file-explorer` checks the named/collapsible root drop target, context-menu destinations, image thumbnails, keyboard/pointer column resizing, remembered width, cancel/reset, draft preservation and responsive layout. Native `<img>` thumbnails use an authenticated, revision-checked `/image` endpoint with no-store and a sandbox CSP; SVG content is never injected into the DOM. Only image suffixes are accepted, members may read, and revoked/trashed projects are rejected. Existing image elements are reused across polling renders, avoiding repeat downloads of unchanged files. `test_file_images.py` checks bytes, response policy, versions and permissions. The browser supplies decoding, with a generic image fallback for unsupported formats.

`python3 tests/run_browser.py --explorer-previews` compiles fictional LaTeX/Typst documents, renders actual PDF.js covers, checks reload/failed-build retention and cover invalidation, and verifies full-name hover/focus in grid/list and mobile views. `test_project_previews.py` checks migration from saved builds, project membership, version checks and deletion cleanup.

`web/project-covers.js` lazily renders only page one, with two concurrent PDF workers and a bounded in-memory image cache. The authenticated `preview.pdf` route reads one retained successful PDF per project from `project_previews`; failed builds preserve it. No thumbnail or project content is written into public source files.

`web/project-worker.js` runs regex and source analysis off the UI thread with a four-second deadline. `workspace-tabs.js` owns split drafts/undo/folding and reuses the primary buffer when both panes show the same file. `source-search.js` searches only the active source draft, preserves full-source offsets through folding, and applies undoable local replacements. `workspace-tools.js` supplies the separate project-content search panel beside the filename-only file filter, outline navigation and review dialogs. Source saves on actual page exit start independently for both buffers; normal app navigation waits for both. Bulk source changes reconnect the current user's Typst session to clear obsolete memory overlays.

On Mac, after compiler setup, run the editor browser suites against a temporary database:

```sh
PLAYWRIGHT_MODULE=/path/to/node_modules/playwright \
NODE_BIN=/path/to/node \
python3 tests/run_browser.py
```

This covers LaTeX/Typst editing and real builds, the project explorer and navigation, and appearance preferences (one-click Light/Dark switching, System in account settings, reload persistence, device changes, tab synchronization, and mobile controls). Selected source text is checked for opacity and readable contrast in all five palettes in light/dark mode. PDF preview checks also cover its independent dark-color switch, persistence, tab synchronization, and unchanged downloaded PDF bytes. It leaves `data/` untouched. Install Playwright separately and use Node 20+; set `CHROME_BIN` when using an existing Chromium browser.

`browser_undo.cjs` checks Ctrl/Cmd+Z, redo with Ctrl/Cmd+Shift+Z or Ctrl+Y, grouped typing/deletion, selections and Tab edits, bracket/quote pairing and deletion, paste/IME guards, autosave, separate file histories, coauthor updates, and source editing. Use `python3 tests/run_browser.py --editor-undo` with the same environment for just these checks. Undo history stays in memory, bounded to 100 steps per file and eight recent files; reloading starts a fresh history.

`web/source-folding.js` keeps full source separate from its visible textarea projection. Its lexer recognizes LaTeX sections/environments/groups and Typst headings/content/code/function blocks, excluding comments, strings and raw/verbatim contents as appropriate. Fold positions rebase after edits and remain in memory for eight recent file keys. The gutter renders only nearby visible rows. Browser input ranges map to full source offsets before editing, history, saving or LSP queries; edits spanning hidden source reveal it first. Copy/cut across folds use the full selected source. Navigation reveals folded targets and scrolls using visible rows. This adds no editor runtime dependency or backend project-data format.

Run `python3 tests/run_browser.py --source-folding` for lexer/projection checks and real browser tests of both formats: nested folds, slide/section boundaries, raw/verbatim exclusions, edit/save/copy/cut preservation, undo/redo, boundary deletion, shifted anchors, file switching, coauthor updates and mobile controls. The native Tinymist suite additionally checks hover positions after earlier folds, definitions into hidden blocks, and preview clicks that expand their target. The real LaTeX source-navigation suite checks folded PDF targets too.

`browser_autosave.cjs` checks source edits in both formats, immediate navigation exits, continued typing during an in-flight save, periodic saving without a typing pause, focus-loss and page-unload saves, delayed file loads, browser Back/Forward, temporary server failures, and coauthor conflict protection. Run just these checks with `python3 tests/run_browser.py --editor-save`. App navigation holds the current editor until its final save and next load finish; small file writes use fetch keepalive, and pending/large writes retain the browser leave warning.

Run the additional native Tinymist suite with the same environment and `python3 tests/run_browser.py --live-typst`. It checks a real WebSocket-rendered document, updates within the same iframe/session with no per-edit PDF requests, completion (including snippet expansion), hover, definitions, formatting, undo/redo of language-tool edits and preview updates after undo, diagnostics/recovery, source reveal, account-menu dismissal on preview clicks, dark preview, project-named PDF/source exports with continued live rendering/LSP, cancelled navigation, and worker cleanup on actual page exit. Preview-to-source checks include opening nested included files with spaces in their names, expanding collapsed folders, scrolling to a nonzero mapped line, and saving changes before navigating back. Both modes use disposable databases and fictional documents.

`tests/test_tinymist.py` runs real native tests when `TINYMIST_BIN` is available on macOS (`./labtex test` supplies it). It checks in-memory edits without overwriting saved source, watcher invalidation for imported files, removal of deleted files and memory overlays from the watched mirror, persistent process reuse, PDF compilation, authentication/roles, account-scoped session IDs, bounded buffers, request allowlisting, crash recovery, and temporary-directory/process cleanup. Linux CI skips these native checks; it continues testing the isolated PDF path.

`typst_service.py` owns each session's stdio JSON-RPC, memory overlays, watched project mirror, and authenticated preview proxy. `web/typst-live.js` supplies language controls and embeds Tinymist's bundled renderer. Browser clients can only request a fixed set of language queries; worker commands, filesystem paths, and preview host arguments are server-owned. The native preview protocol and renderer version move together in the pinned Tinymist binary. Recheck protocol behavior and both Mac architecture hashes when updating it.

`source_map.py` reads bounded SyncTeX v1 line anchors from Tectonic/latexmk output before the temporary build is removed. Only paths matching files in that compiled project enter the compact map; host paths and TeX installation files are discarded. `build_sources` stores the map alongside the corresponding PDF build timestamp. The authenticated `synctex?v=...` and versioned PDF endpoints prevent mixing two builds. Existing databases gain the new table automatically; old PDFs remain viewable and gain mappings on their next compile. Permanent project deletion also clears these maps. `web/pdf-viewer.js` renders nearby pages with PDF.js, selectable text and links, limits concurrent renders/canvas resolution, and releases offscreen canvases. Its source messages are accepted only from the active preview iframe for the current project/build and an existing project file; navigation uses the same autosave path as file-tree and Typst navigation.

Run `python3 tests/run_browser.py --latex-source` with the browser environment above for real multi-file/two-column/multi-page LaTeX checks: mapped cursor positions, collapsed folders, delayed saves, selection, zoom, reference links, dark preview, message guards and PDF export. `tests/test_source_map.py` checks real compiler output, nested main files, coordinate units/compression, host-path exclusion, old-build compatibility, access revocation, version mismatches and deletion cleanup. The default browser suite also includes the LaTeX source-navigation fixture.

`browser_editor_layout.cjs` checks full-height panes without headers/footers, project options, one-click backup/preview controls beside the theme toggle, file history in context menus, outside/Escape dismissal, persistent file-explorer visibility with its toggle in the column and collapsed rail, Ctrl/Cmd+B without losing drafts or undo, and a mobile drawer without viewport overflow.

File-tree checks cover nested folder controls, keyboard operation, persistence across refreshes and projects, and search results inside collapsed folders. They also check raster/SVG previews, optional SVG source, restoration of document editing mode, unchanged image bytes, and that SVG scripts/external references do not execute.

`browser_project_folders.cjs` checks nested project folders, breadcrumbs, move dialogs and drag/drop, folder links and browser history, search across folders, creation/import into the current folder, rename/reparent, empty-folder deletion, and grid/list/dark/mobile views. It also verifies that moving a project leaves its content and revision unchanged.

`browser_templates_palettes.cjs` checks all five palettes in light/dark mode, the Western explorer's white light-mode background, migration of retired palette preferences, text contrast, tab synchronization and persistence, source/PDF preservation, mobile controls, template gallery creation in the current folder, and real Western/NeurIPS builds. Backend template tests also check private independent copies, authentication, quotas, and upstream file hashes in `templates/upstream.json`.

`browser_project_actions.cjs` checks explorer source ZIP downloads and Rename/Move/Delete menus in grid/list and dark/mobile views, keyboard dismissal, name validation, persistence, shared permissions, request failures, Trash confirmation, and preservation of unrelated projects. Downloads verify project-based filenames, LaTeX/Typst source and nested assets, viewer access, and that the explorer stays open. It only deletes fictional disposable fixtures.

`browser_library_layout.cjs` checks library search and format filtering, creation only on request, current-folder copies, account-menu keyboard navigation, outside pointer dismissal (including PDF-pane clicks), equal folder/project tile sizes, and absence of decorative footer text at desktop, laptop, and mobile viewport sizes. All eight starter templates are compiled in backend tests.

`browser_file_creation.cjs` checks inline project naming (Enter, Escape and blur), folder and root context menus, nested create/upload destinations, traversal rejection, overwrite cancellation, source/draft/selection/undo preservation, keyboard access and viewer permissions.

`browser_file_actions.cjs` verifies right-click and keyboard menus that preserve the open editor, separate action targets, targeted history inspection/restoration without changing the editor, restore conflict protection and viewer access, rename collisions, file download, replacement history and conflict protection, deletion confirmation, the main-document guard, viewer permissions, and mobile bounds. PDF and source ZIP exports are checked for project-based filenames. `browser_drag_live.cjs` covers editor file/folder moves, explorer folder moves and parent/root navigation, desktop/mobile action rows, Typst PDF export without an embedded PDF view, backup menus, saved-token reuse/removal, and the explorer’s one-click global push (button placement, duplicate-click protection, setup fallback, partial/HTTP failures, and preservation of separate project settings). Use `python3 tests/run_browser.py --backup-ui` with the same environment for the focused backup UI suites. Browser fixtures inject a temporary file credential store; they never access real Keychain entries. Backend checks cover account isolation and credential persistence, with no live GitHub writes. Project backup-status checks verify that shared snapshot records survive restarts, remain separate from per-project destination settings, report pending changes and destination changes, preserve previous snapshots on failure, migrate older records without claiming branch verification, and enforce owner-only access. GitHub snapshot tests model readable project folders, stable duplicate suffixes, Unicode/path sanitization, atomic migration from ID folders, project renames, unrelated-file preservation, blob reuse, and failed concurrent updates.

`browser_file_selection.cjs` checks Cmd/Ctrl and Shift selection, modifier-free selection mode, recursive folder deletion, cancellation, main-document protection, concurrent changes, viewer permissions, mobile menus, and preservation of unrelated drafts, cursor and undo history. `tests/test_file_delete.py` checks that `POST /api/projects/:id/delete-files` validates the complete selection and project revision before atomically deleting source and saved history, including overlapping folders, prefix siblings and maximum-length requests. Run `python3 tests/run_browser.py --file-actions` for the focused file-action, move, undo and autosave suites.

Bundled starters live under `templates/`; `project_templates.py` lists their public metadata and loads only those fixed directories. Keep personal source out of this catalog. Preserve upstream notices and update recorded hashes deliberately when replacing Touying or the NeurIPS author kit. The release checker permits only the original upstream author contact in each specific attribution file, and the Western logo as a reviewed template image.

For the Linux deployment's browser checks:

Use a **new disposable checkout**, run setup, and start it on port 8878. The browser test creates accounts and edits/deletes project content; never run it on a real installation. It intentionally uses obvious test-only passwords. Install Playwright in a separate temporary tooling folder:

```bash
mkdir -p /tmp/idsl-browser-tools
cd /tmp/idsl-browser-tools
npm install --no-save playwright
npx playwright install chromium
cd /PATH/TO/DISPOSABLE/idsl-latex
./labtex start --port 8878
PLAYWRIGHT_MODULE=/tmp/idsl-browser-tools/node_modules/playwright \
TEST_ORIGIN=http://127.0.0.1:8878 \
TEST_SETUP_TOKEN_FILE="$PWD/.local/setup-token" \
node tests/browser_smoke.cjs
./labtex uninstall-service
```

The test checks source editing, autosave, PDF preview/export, viewer access, private member projects, outsider rejection, source ZIP round trips, and recovery from a failed build. Generated PDFs and screenshots stay in ignored `artifacts/`. Set `CHROME_BIN` only if you need a specific installed Chromium binary. Linux browser system libraries may also need installation; follow Playwright's requirements for your test host.

## Documentation screenshots

`python3 tests/run_browser.py --autocomplete` checks automatic/manual completions, snippets, project references, undo, folded-source offsets and viewer permissions on disposable data. `--live-typst` also runs these checks against Tinymist. `web/completions.js` supplies the local LaTeX/Typst candidates; the existing language-tools controller handles keyboard/pointer interaction and full-source insertion. Related-file lookups stay within the current project, cache by file revision, and cap their count and bytes.

Regenerate the README images after compiler setup using the same temporary-server harness:

```sh
PLAYWRIGHT_MODULE=/path/to/node_modules/playwright \
NODE_BIN=/path/to/node \
python3 tests/run_browser.py --screenshots
```

This runs `tests/capture_docs.cjs` instead of the regression suites. It requires a fresh database, creates only fictional `example.test` demo accounts and starter documents, captures grid/list/mobile project views, both editors (a classic LaTeX article is the main README image), source folding, multiple-file selection, live Typst/LSP, the template library, account dropdown, sharing, GitHub settings, dark mode, the palette picker, and the Western/NeurIPS starters into `docs/images/`, then discards the database. It waits for actual PDF/live rendering before capturing. It never uses the personal installation or writes to GitHub. The backup screenshot leaves its token field empty; sharing screenshots must not show generated invitation links.

The screenshot runner also refreshes `docs/images/typst-live.png` directly; the native regression suite keeps its separate test image in ignored `artifacts/`. Keep the classic LaTeX editor as the main README image.

Inspect every screenshot before publishing. Check image metadata as well as visible pixels; never capture live projects or use redaction as a substitute for a disposable fixture.

## Release privacy checks

Publish source, not a working installation. Use a fresh Git history for the first release and inspect all tracked files, filenames, commit messages, and author metadata. Use a GitHub no-reply commit email if desired.

```bash
python3 scripts/check_release.py
git diff --check
git archive --format=zip --prefix=idsl-latex/ -o /tmp/idsl-latex-source.zip HEAD
```

The guard rejects private/runtime filenames, large binaries, real email addresses, host home paths, live trial hostnames, and common credential formats. It cannot detect every possible secret. Also run an independent secret scanner such as [Gitleaks](https://github.com/gitleaks/gitleaks) on **all Git history** and the extracted release archive, and inspect unexpected findings manually. Never put real credentials into an allowlist to make a scan pass.

Keep the source archive checksum with the release. Verify the public GitHub tree and downloadable archive after upload. Runtime databases, lab membership rosters, live endpoint URLs, private setup tokens, invitation links, and host configuration must never be release assets.

`test_trash.py` checks owner-only retention, access blocking, restore, expired-project cleanup, source/history/backup retention, permanent deletion, folder fallback and quotas. `browser_trash.cjs` checks editor deletion after the final autosave, persistent restore, permanent-delete cancellation and mobile layout. Browser suites purge only their deleted fictional fixtures between scripts.

`test_project_copy.py` checks same-folder source copies, assets and selected main document, independent ownership/content, unique bounded names, quota/Trash/authentication checks and per-account folder isolation. `browser_project_copy.cjs` checks grid/list duplication, autosave and opening the root projects view through **My projects** after reload, direct links and global filters, with one root breadcrumb and mobile layout.

## Update-enabled release packages

The updater follows stable GitHub releases, not every push to `main`. Before publishing, complete the performance/privacy review in [PERFORMANCE.md](PERFORMANCE.md), set the root `VERSION` to the intended stable version, and commit/tag that exact reviewed source. Then build from the immutable tag:

```sh
python3 scripts/build_release.py v0.4.0
```

The script verifies `VERSION`, packages only files in that Git commit, rejects private/runtime paths and symlinks, and writes `dist/idsl-latex-v0.4.0.zip` plus `dist/idsl-latex-v0.4.0-SHA256SUMS.txt`. The ZIP embeds an `idsl-release.json` with repository, version, commit and individual source hashes. Do not commit the generated manifest or `dist/`.

Attach both files to the matching GitHub release. Confirm the ZIP's `digest` in the public release API matches its SHA-256, then publish it as a stable release. A tag or GitHub-generated source archive alone does not provide the verified package needed by the in-app installer. Preview/development versions do not replace stable installs. Existing old ZIPs without the manifest remain manual upgrades.

The **Release update packages** workflow also builds and attaches these files when a stable release is published. It checks out that exact tag, runs source hygiene, and refuses to replace an existing asset with different bytes. Upload credentials are available only to the attachment step. If publishing through GitHub's UI, wait for this workflow to finish before asking users to install; failed packaging leaves installation disabled. The pre-release performance/privacy review still applies.

`deploy/updates.py` uses one sleeping release-check thread only in managed local Mac mode. Metadata checks are daily/cached, manual checks are throttled for one minute, response/download/extraction sizes are bounded, redirects stay on fixed GitHub hosts, and no backup credential or installation fingerprint enters requests. No source is downloaded or changed until the administrator approves a specific version/digest.

Installation runs in a copied helper under private `.local/updates/` so it survives replacing app source. It refuses changed code, pins Git fast-forward/tag/package identity, verifies the ZIP and all files before stopping, waits for active compile/backup jobs, backs up SQLite using the backup API, preserves installation state, validates startup under a write barrier, and rolls back failed updates. Archive application only replaces manifest-owned files. One private rollback snapshot is retained; unsuccessful recovery requires an explicit helper invocation instead of another install.

`tests/test_updates.py` uses fake releases and temporary archive/Git installations to check explicit approval, throttling, checksums, paths, permissions, data/settings retention and failure recovery. `tests/test_update_restart.py` uses real local launcher processes on Mac for a successful update and a failed startup/database migration with rollback. It never touches the personal installation or real GitHub. `python3 tests/run_browser.py --updates` checks the badge, manual check, opt-out, safe release notes, save-before-install, exact consent payload, progress/reload and dirty-code blocking using mocked update requests. Browser tooling remains a test-only dependency.
