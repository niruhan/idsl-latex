# Performance review

Lean runtime and a performance review before every release are repository policy in [AGENTS.md](../AGENTS.md). Keep working features, privacy, autosave and conflict protection intact. Prefer removing redundant work over adding infrastructure.

## October 2026 audit

The review covered browser startup, source editing/folding/undo, search/completions, tabs, project/file navigation, image/PDF previews, live compiler lifecycle, HTTP/database access, archives, GitHub operations, retained caches and runtime dependencies. Personal projects and credentials were not used.

Changes:

- Conditional, authenticated project metadata requests skip file enumeration and response bodies when unchanged. File trees, tabs and split-file choices retain their existing DOM and focus.
- Cursor/find navigation reuses source projections and highlight ranges. Large documents color only nearby source lines; plain prefix/suffix text preserves complete offsets for search, folding and selections.
- Hidden document statistics are not recalculated on every key. Global search reuses revision-keyed source reads and overlays current drafts; find-only queries no longer construct or return complete replacement documents.
- Multi-file upload refreshes metadata once after the batch rather than after each file. Server paths still validate each upload and reject conflicting revisions.
- Expired GitHub restore/sync reviews are released by periodic maintenance even when no new review opens. Active operations retain their snapshots until completion.
- Source-fold caches have an aggregate text budget; tab position history is bounded. Project covers have a 12 MiB encoded-image budget plus a 64-entry limit. Leaving a project releases its image elements and editor DOM.
- Offscreen PDF pages release text layers, page resources and source-hit references. Identical live-compiler status no longer rebuilds diagnostics; hidden tabs pause their status requests and closed compiler managers unregister shutdown hooks.
- Project-scoped indexes support history, checkpoints and membership lookups. Metadata builds its folder list from already-read filenames rather than querying them twice.
- Public static assets use conditional browser revalidation. Project source, images, PDFs and credentials retain their private no-store behavior.
- ZIP exports/checkpoints/baselines store already-compressed image/font/archive assets directly while compressing source. File bytes and directory entries are preserved.
- Removed the unused visual-editor module and its base styles. No production npm/pip dependencies or new background services were added.

## Reproducible measurements

The disposable browser fixture uses 251 files, a 98,579-byte source document with 1,400 headings/search matches, and two metadata polls over 8.5 seconds. These observations come from the same local Mac/Chromium setup. Timings include browser automation overhead and are examples, not guarantees for every machine.

| Measurement | Before | After |
| --- | ---: | ---: |
| Idle file-tree DOM mutations | 506 | 0 |
| Idle tab DOM mutations | 4 | 0 |
| Unchanged metadata body bytes | 31,452 | 0 |
| Full source repaints during 20 search-next actions | 20 | 0 |
| 20 search-next actions | 4,758 ms | 432 ms |
| Median single-character insertion | 58 ms | 27 ms |

A separate 8 MiB incompressible asset fixture averaged 145.10 ms with repeated ZIP deflation and 0.95 ms when stored directly (three runs). This targets assets that are already compressed; ordinary source still benefits from deflation.

The browser records JavaScript heap after collection, but does not gate releases on noisy absolute heap/timing values. It does not measure native Tinymist RSS or total browser memory. Native compiler memory still depends on the document; session counts, lifetime, source limits and cleanup remain bounded and have separate integration tests.

## Before each release

1. Review the full runtime for new polling, repeated parsing/rendering, unnecessary requests, duplicate implementations, unused dependencies and unbounded retained resources. Check success, failure, cancellation and navigation paths. Fix verified regressions before publishing.
2. Run `./labtex test` and `python3 tests/run_browser.py --performance` with the browser environment from [DEVELOPMENT.md](DEVELOPMENT.md). Run the relevant editor, native compiler, PDF, collaboration and export suites as well.
3. Compare the same fictional workload with this baseline. The performance test asserts zero idle tree/tab churn, zero unchanged metadata bodies, and no redundant source repaint in the navigation workload. Investigate regressions; do not relax a budget solely to make a release pass.
4. Review public-source hygiene and secrets, then record measurements, fixes and unrun platform checks in the release validation notes. Runtime databases, profiling output and benchmark artifacts stay outside public source.

The GitHub workflow also runs the large-project browser guard with isolated, pinned Playwright tooling. Browser tooling is only a test dependency. Set `PERFORMANCE_REPORT` to an ignored or temporary JSON path to retain local measurements. `PERF_BASELINE=1` records a comparison without enforcing the budgets and is for deliberate before/after analysis, not release validation.
