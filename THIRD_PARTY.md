# Dependencies

Dependencies are downloaded during setup; their binaries and package archives are not included in the source repository or release ZIP.

| Component | Purpose | Source and license |
| --- | --- | --- |
| Tectonic 0.17.0 | LaTeX and bibliography compilation | [Project](https://github.com/tectonic-typesetting/tectonic), MIT |
| Tectonic default bundle v33 | Offline TeX packages, fonts, and formats | [Bundle](https://relay.fullyjustified.net/default_bundle_v33.tar); individual package licenses apply |
| cloudflared 2026.10.1 | Optional outbound HTTPS trial tunnel | [Project](https://github.com/cloudflare/cloudflared), Apache-2.0 |
| Bubblewrap | Linux filesystem/process/network isolation | [Project](https://github.com/containers/bubblewrap), LGPL-2.0-or-later; installed by the OS package manager |
| Python, SQLite, systemd, fonts | Runtime and host services | Supplied by your Linux distribution under their respective licenses |

Exact download URLs and SHA-256 digests are in [deploy/dependencies.json](deploy/dependencies.json). The compiler and connector hashes match their upstream GitHub release metadata. The bundle hash records the downloaded public archive. No installation-specific settings or credentials belong in this manifest.

## macOS local compiler downloads

- [Typst](https://github.com/typst/typst), Apache-2.0. Official binaries include their font/license notices in the release archive, retained under `.local/downloads`.
- [Tinymist 0.15.10](https://github.com/Myriad-Dreamin/tinymist), Apache-2.0. Provides the persistent Typst compiler, language server, and bundled preview frontend. Its executable and third-party renderer dependencies are downloaded as part of the pinned upstream release, outside the source tree.
- [Tectonic](https://github.com/tectonic-typesetting/tectonic), MIT. Its downloaded TeX packages/fonts retain their respective licenses.

macOS archive versions, URLs, and SHA-256 digests are pinned for Apple Silicon and Intel in `deploy/local-dependencies.json`.

## Bundled starter templates and palette references

- The Western presentation adapts the supplied slide scaffold with placeholder author details and app-authored example slides. [Touying 0.5.3](https://github.com/touying-typ/touying) is bundled once under `typst-packages/preview/touying/0.5.3/` with its original MIT license and attribution. The PDF compiler and Tinymist read this shared package; it is not copied into new projects. Public package provenance and file hashes are in `templates/upstream.json`.
- The Western University name and supplied logo remain Western's trademarks, outside this app's MIT license. See [Western brand guidance](https://brand.westernu.ca/). The starter is not an official university template or endorsement.
- The NeurIPS starter includes the unmodified official 2026 `neurips_2026.sty` and `checklist.tex`, credited to the NeurIPS 2026 Program Chairs and the style's original authors. The [official template listing](https://www.overleaf.com/latex/templates/formatting-instructions-for-neurips-2026/bjdwqfdkyftc) specifies [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The manuscript example is app-authored; full attribution, source links, and usage notes are in the starter README. Archive/file hashes are recorded in `templates/upstream.json`.
- The classic article, coursework assignment, Beamer presentation, academic CV, and Western thesis scaffold are app-authored examples with placeholder content. They use built-in Typst features or standard TeX packages supplied by the compiler. The thesis scaffold is not an approved university submission template.
- Interface palette references: [Western](https://brand.westernu.ca/visual-identity/colours.html), [Nord](https://www.nordtheme.com/docs/colors-and-palettes/), [GitHub Primer](https://primer.style/product/primitives/color/), and [Solarized by Ethan Schoonover](https://ethanschoonover.com/solarized/). App-authored UI styles adapt these color palettes for readable light/dark interfaces. No upstream theme extension code is included.
