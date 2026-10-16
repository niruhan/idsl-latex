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
