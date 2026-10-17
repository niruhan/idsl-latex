# Development and release validation

The runtime is Python's standard library plus plain browser JavaScript. There is no production npm/pip dependency tree. Linux compiler and tunnel downloads are pinned in `deploy/dependencies.json`; Mac compilers are pinned in `deploy/local-dependencies.json`. See [local development](LOCAL.md) for the Mac runner and isolated browser suite.

## Automated tests

After setup:

```bash
./labtex test
```

Tests use temporary databases and fictional addresses under `example.test`. They cover authentication, invitation expiry/reuse/revocation, independent projects, project permissions, concurrent-save conflicts, ZIP traversal, history quotas, request limits, per-client throttling, PDF build success/failure, and private/idempotent Typst sample creation with quota enforcement. Sandbox tests check that private files and environment values are hidden, system mounts are read-only, and the compiler has no external network.

The installer also checks namespaces and compiles a real sample through the offline compiler. `./labtex doctor` repeats these checks. Never bypass failed isolation checks for a shared deployment.

CI runs the backend/installer tests with a distribution TeX Live installation. Native sandbox tests skip there because the production bundle is not configured. Full native installation, nested compilation, and browser tests must also pass on a disposable Linux installation before a release. Mac validation does not establish that Linux sandbox installation is working.

## Browser regression test

On Mac, after compiler setup, run all four browser suites against a temporary database:

```sh
PLAYWRIGHT_MODULE=/path/to/node_modules/playwright \
NODE_BIN=/path/to/node \
python3 tests/run_browser.py
```

This covers LaTeX/Typst editing and real builds, the project explorer and navigation, and appearance preferences (one-click Light/Dark switching, System in account settings, reload persistence, device changes, tab synchronization, and mobile controls). It leaves `data/` untouched. Install Playwright separately and use Node 20+; set `CHROME_BIN` when using an existing Chromium browser.

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

The test checks visual editing, autosave, PDF preview/export, viewer access, private member projects, outsider rejection, source ZIP round trips, and recovery from a failed build. Generated PDFs and screenshots stay in ignored `artifacts/`. Set `CHROME_BIN` only if you need a specific installed Chromium binary. Linux browser system libraries may also need installation; follow Playwright's requirements for your test host.

## Documentation screenshots

Regenerate the README images after compiler setup using the same temporary-server harness:

```sh
PLAYWRIGHT_MODULE=/path/to/node_modules/playwright \
NODE_BIN=/path/to/node \
python3 tests/run_browser.py --screenshots
```

This runs `tests/capture_docs.cjs` instead of the regression suites. It requires a fresh database, creates only fictional `example.test` demo accounts and starter documents, captures grid/list/mobile project views, both editors, visual mode, sharing, GitHub settings, and dark mode into `docs/images/`, then discards the database. It never uses the personal installation or writes to GitHub. The backup screenshot leaves its token field empty; sharing screenshots must not show generated invitation links.

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
