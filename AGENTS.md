# IDSL Editor development policy

Keep the application lean and responsive. This applies to every future change.

- Preserve the standard-library Python/plain-JavaScript runtime. Add dependencies, background services, abstractions or caches only when a concrete need outweighs their startup, maintenance and memory costs.
- Keep typing, cursor movement and navigation free of redundant source parsing, DOM reconstruction, synchronous storage writes and whole-project requests. Reuse unchanged views, debounce expensive work, and fetch only data needed by the current action.
- Bound retained source, undo, images, review plans, workers and queues. Define expiry, cancellation, error recovery and cleanup for every new resource. Hidden/inactive views should not do unnecessary work.
- Preserve autosave, undo, conflict checks, source bytes, permissions, local compilation and privacy. Optimize with evidence; do not remove functionality or change source to make a benchmark pass.
- Before every GitHub release: audit the full runtime, with extra attention to changed paths and their dependencies for redundant work, leaks, unbounded growth, duplicate implementations and obsolete UI/code; fix verified regressions. Run `./labtex test`, `python3 tests/run_browser.py --performance`, and browser/native-compiler checks relevant to the release. Compare measurements with `docs/PERFORMANCE.md`, review release privacy, and record results and any unrun/platform-specific checks. Do not publish a release while an identified performance regression remains unexplained.
- For update-enabled releases, set `VERSION` to the stable version before tagging, build the immutable source ZIP with `scripts/build_release.py`, and attach it and its checksum file to that same GitHub release. Verify the asset digest. Never bypass local-change checks, approval, backups or rollback to make an update install.
- Keep README setup short. Document architecture/performance evidence in the development guides instead of adding explanatory product UI.

Use disposable databases and fictional projects for tests, benchmarks and screenshots. Never benchmark by exporting personal projects or reading saved credentials. Do not commit runtime databases, caches, build output, benchmark artifacts or tokens.
