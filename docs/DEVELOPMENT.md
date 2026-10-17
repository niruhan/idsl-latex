# Development and release validation

The runtime is Python's standard library plus plain browser JavaScript. There is no production npm/pip dependency tree. On Mac, the verified Tinymist executable provides a persistent compiler, LSP, and bundled live renderer. Linux compiler and tunnel downloads are pinned in `deploy/dependencies.json`; Mac compilers are pinned in `deploy/local-dependencies.json`. See [local development](LOCAL.md) for the Mac runner and isolated browser suite.

## Automated tests

After setup:

```bash
./labtex test
```

Tests use temporary databases and fictional addresses under `example.test`. They cover authentication, invitation expiry/reuse/revocation, independent projects, project permissions, concurrent-save conflicts, ZIP traversal, history quotas, request limits, per-client throttling, PDF build success/failure, and private/idempotent Typst sample creation with quota enforcement. Project-folder tests check per-user isolation, viewer organization, atomic creation, persistence, empty-only deletion, name validation, cycle/depth limits, quotas, and placement cleanup. Sandbox tests check that private files and environment values are hidden, system mounts are read-only, and the compiler has no external network.

The installer also checks namespaces and compiles a real sample through the offline compiler. `./labtex doctor` repeats these checks. Never bypass failed isolation checks for a shared deployment.

CI runs the backend/installer tests with a distribution TeX Live installation. Native sandbox tests skip there because the production bundle is not configured. Full native installation, nested compilation, and browser tests must also pass on a disposable Linux installation before a release. Mac validation does not establish that Linux sandbox installation is working.

## Browser regression test

On Mac, after compiler setup, run the editor browser suites against a temporary database:

```sh
PLAYWRIGHT_MODULE=/path/to/node_modules/playwright \
NODE_BIN=/path/to/node \
python3 tests/run_browser.py
```

This covers LaTeX/Typst editing and real builds, the project explorer and navigation, and appearance preferences (one-click Light/Dark switching, System in account settings, reload persistence, device changes, tab synchronization, and mobile controls). Selected source text is checked for opacity and readable contrast in all five palettes in light/dark mode. PDF preview checks also cover its independent dark-color switch, persistence, tab synchronization, and unchanged downloaded PDF bytes. It leaves `data/` untouched. Install Playwright separately and use Node 20+; set `CHROME_BIN` when using an existing Chromium browser.

`browser_undo.cjs` checks Ctrl/Cmd+Z, redo with Ctrl/Cmd+Shift+Z or Ctrl+Y, grouped typing/deletion, selections and Tab edits, autosave, separate file histories, coauthor updates, and source editing. Use `python3 tests/run_browser.py --editor-undo` with the same environment for just these checks. Undo history stays in memory, bounded to 100 steps per file and eight recent files; reloading starts a fresh history.

`browser_autosave.cjs` checks source edits in both formats, immediate navigation exits, continued typing during an in-flight save, periodic saving without a typing pause, focus-loss and page-unload saves, delayed file loads, browser Back/Forward, temporary server failures, and coauthor conflict protection. Run just these checks with `python3 tests/run_browser.py --editor-save`. App navigation holds the current editor until its final save and next load finish; small file writes use fetch keepalive, and pending/large writes retain the browser leave warning.

Run the additional native Tinymist suite with the same environment and `python3 tests/run_browser.py --live-typst`. It checks a real WebSocket-rendered document, updates within the same iframe/session with no per-edit PDF requests, completion (including snippet expansion), hover, definitions, formatting, undo/redo of language-tool edits and preview updates after undo, diagnostics/recovery, source reveal, account-menu dismissal on preview clicks, dark preview, project-named PDF/source exports with continued live rendering/LSP, cancelled navigation, and worker cleanup on actual page exit. Both modes use disposable databases and fictional documents.

`tests/test_tinymist.py` runs real native tests when `TINYMIST_BIN` is available on macOS (`./labtex test` supplies it). It checks in-memory edits without overwriting saved source, watcher invalidation for imported files, persistent process reuse, PDF compilation, authentication/roles, account-scoped session IDs, bounded buffers, request allowlisting, crash recovery, and temporary-directory/process cleanup. Linux CI skips these native checks; it continues testing the isolated PDF path.

`typst_service.py` owns each session's stdio JSON-RPC, memory overlays, watched project mirror, and authenticated preview proxy. `web/typst-live.js` supplies language controls and embeds Tinymist's bundled renderer. Browser clients can only request a fixed set of language queries; worker commands, filesystem paths, and preview host arguments are server-owned. The native preview protocol and renderer version move together in the pinned Tinymist binary. Recheck protocol behavior and both Mac architecture hashes when updating it.

`browser_editor_layout.cjs` checks full-height panes without headers/footers, project options, one-click backup/preview controls beside the theme toggle, file history in context menus, outside/Escape dismissal, persistent file-explorer visibility with its toggle in the column and collapsed rail, Ctrl/Cmd+B without losing drafts or undo, and a mobile drawer without viewport overflow.

File-tree checks cover nested folder controls, keyboard operation, persistence across refreshes and projects, and search results inside collapsed folders. They also check raster/SVG previews, optional SVG source, restoration of document editing mode, unchanged image bytes, and that SVG scripts/external references do not execute.

`browser_project_folders.cjs` checks nested project folders, breadcrumbs, move dialogs and drag/drop, folder links and browser history, search across folders, creation/import into the current folder, rename/reparent, empty-folder deletion, and grid/list/dark/mobile views. It also verifies that moving a project leaves its content and revision unchanged.

`browser_templates_palettes.cjs` checks all five palettes in light/dark mode, the Western explorer's white light-mode background, migration of retired palette preferences, text contrast, tab synchronization and persistence, source/PDF preservation, mobile controls, template gallery creation in the current folder, and real Western/NeurIPS builds. Backend template tests also check private independent copies, authentication, quotas, and upstream file hashes in `templates/upstream.json`.

`browser_project_actions.cjs` checks explorer source ZIP downloads and Rename/Move/Delete menus in grid/list and dark/mobile views, keyboard dismissal, name validation, persistence, shared permissions, request failures, typed deletion confirmation, and preservation of unrelated projects. Downloads verify project-based filenames, LaTeX/Typst source and nested assets, viewer access, and that the explorer stays open. It only deletes fictional disposable fixtures.

`browser_library_layout.cjs` checks library search and format filtering, creation only on request, current-folder copies, account-menu keyboard navigation, outside pointer dismissal (including PDF-pane clicks), equal folder/project tile sizes, and footer clearance at desktop, laptop, and mobile viewport sizes. All eight starter templates are compiled in backend tests.

`browser_file_actions.cjs` verifies right-click and keyboard menus that preserve the open editor, separate action targets, targeted history inspection/restoration without changing the editor, restore conflict protection and viewer access, rename collisions, file download, replacement history and conflict protection, deletion confirmation, the main-document guard, viewer permissions, and mobile bounds. PDF and source ZIP exports are checked for project-based filenames. `browser_drag_live.cjs` covers editor file/folder moves, explorer folder moves and parent/root navigation, desktop/mobile action rows, Typst PDF export without an embedded PDF view, backup menus, and saved-token reuse/removal. Use `python3 tests/run_browser.py --backup-ui` with the same environment for the focused backup UI suites. Browser fixtures inject a temporary file credential store; they never access real Keychain entries. Backend checks cover account isolation and credential persistence, with no live GitHub writes. Project backup-status checks verify that shared snapshot records survive restarts, remain separate from per-project destination settings, report pending changes and destination changes, preserve previous snapshots on failure, migrate older records without claiming branch verification, and enforce owner-only access. GitHub snapshot tests model readable project folders, stable duplicate suffixes, Unicode/path sanitization, atomic migration from ID folders, project renames, unrelated-file preservation, blob reuse, and failed concurrent updates.

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

Regenerate the README images after compiler setup using the same temporary-server harness:

```sh
PLAYWRIGHT_MODULE=/path/to/node_modules/playwright \
NODE_BIN=/path/to/node \
python3 tests/run_browser.py --screenshots
```

This runs `tests/capture_docs.cjs` instead of the regression suites. It requires a fresh database, creates only fictional `example.test` demo accounts and starter documents, captures grid/list/mobile project views, both editors (a classic LaTeX article is the main README image), the template library, account dropdown, source editing, sharing, GitHub settings, dark mode, the palette picker, and the Western/NeurIPS starters into `docs/images/`, then discards the database. It never uses the personal installation or writes to GitHub. The backup screenshot leaves its token field empty; sharing screenshots must not show generated invitation links.

The native suite also writes `artifacts/tinymist-live.png`; after inspecting it, copy it to `docs/images/typst-live.png`. Keep the classic LaTeX editor as the main README image.

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
