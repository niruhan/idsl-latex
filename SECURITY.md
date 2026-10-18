# Security

This is an invite-only application intended for small, trusted groups. It is not a hardened public compile farm. Report suspected vulnerabilities privately through this repository's **Security → Report a vulnerability** tab. Do not attach real documents, credentials, invitation links, databases, or server logs to a public issue.

## Boundaries

The Linux launcher runs the backend inside a Bubblewrap filesystem with read-only application and runtime mounts, a writable database directory, and private temporary build storage. Other home directories, host configuration, SSH keys, and private deployment logs are not mounted. The backend retains host networking so it can serve the loopback listener. A compromised backend could still make outbound or local network connections and read the app database.

Every compilation runs in an additional namespace with no host network, no host home directories, a cleared environment, a read-only TeX installation, and only that compilation's files writable. Tectonic runs in untrusted mode with shell escape disabled. The compiler has memory/output/time limits; the whole service has a 2 GiB memory limit, no swap allowance, one CPU quota, and a task limit.

These controls share the host kernel. They do not eliminate kernel, parser, runtime, supply-chain, or application vulnerabilities. Run public installations in a dedicated VM/account with no unrelated credentials or sensitive mounts. Do not run the launcher as root. Other processes running under the same Unix account are trusted and can read that account's app data. The app cannot protect its database from the server operator.

## Authentication and admission

- First setup requires a freshly generated private bootstrap token. There are no shipped accounts, passwords, or live invitation tokens.
- Passwords use salted PBKDF2-HMAC-SHA256 with 600,000 iterations. Session tokens and invitations are random and stored hashed. Sessions expire after seven days.
- Cookies are HttpOnly, SameSite=Strict, and Secure for HTTPS origins. Requests validate Host and Origin; the frontend uses a restrictive content security policy.
- Account invitations are single-use, expire after seven days, and require an exact approved address. Email ownership is **not** verified. Link possession authorizes signup; distribute links privately.
- The project explorer only lists accessible projects. The sample endpoint creates a private project for the current account, enforces ownership and project limits, and preserves sample edits on later visits.
- Project permissions are checked on each request. Account administration does not grant document access through the UI/API.
- Multi-file and recursive source-folder deletion require project write access, validated relative paths and the reviewed project revision. The entire selection is validated before deleting source and saved history in one transaction; the main document cannot be deleted. These file actions are permanent, separate from whole-project Trash.
- Anyone with project read access may duplicate its current source into a private owned project, matching source ZIP download/import access. Copies use the caller’s folder placement and quota; other members, history, builds and backup settings are not copied.
- Project folders and placements are scoped to the signed-in account. Viewers can organize accessible projects without gaining write access or changing another user's layout. Folder creation and nesting are bounded; deletion requires an empty folder.
- The starter gallery lists bundled public templates. Instantiation creates a private owned project, applies folder ownership checks and project quotas, and never reads a user-supplied filesystem path. Browsing the gallery creates no projects.
- Request concurrency, body sizes, authentication attempts, uploads, build queues, history, and per-account project counts are bounded. These are availability mitigations, not a complete denial-of-service defense or global disk quota.

## Hosting

The backend listens only on `127.0.0.1`. Quick Tunnels expose the login page through an outbound Cloudflare connection. Public HTTPS does not make an app immune to attacks. Cloudflare sees proxied traffic. Restrict accounts and invitations, keep the OS current, and prefer private network access where appropriate.

The Cloudflare client-IP header is trusted only in the bundled Quick Tunnel mode. In custom reverse-proxy mode it is not trusted; authentication throttling groups clients by the proxy's loopback address. Add rate limiting/access controls at your proxy for larger deployments. Never expose the raw backend port or rely on a secret hostname.

## Private files and updates

Never commit or upload `data/`, `.local/`, backups, `.env` files, logs, browser artifacts, or your whole installed folder. Source archives must come from Git's tracked files. Public tests use fictional `example.test` accounts and test-only password strings that do not grant access to any shipped or hosted account.

Installers check pinned SHA-256 hashes for public dependencies before using them. This detects corrupt or changed downloads, but is not an independent guarantee of upstream integrity. Review upstream security releases and update `deploy/dependencies.json` and `deploy/local-dependencies.json` deliberately. The package bundle is pinned for reproducibility and may not contain recent packages. Tectonic is MIT-licensed; cloudflared is Apache-2.0; the TeX bundle includes packages under multiple licenses.

Only the latest published release is maintained. Back up before upgrading. If a real credential is accidentally published, revoke/rotate it immediately; deleting the current file alone does not remove it from Git history, clones, or caches.

## Personal macOS mode and GitHub backups

The Mac local runner binds to loopback and runs compilers as the current user, using a dedicated compiler home, Tectonic untrusted mode, Typst project-root limits, and bounded builds. It does not provide Bubblewrap/cgroup isolation. Use it for trusted personal projects; keep shared/public hosting on Linux. See [local mode](docs/LOCAL.md).

The local Tinymist service requires write access to the project and scopes each live session to its signed-in account. It copies project files into a private temporary mirror, sends unsaved changes as LSP memory overlays, and passes only selected compiler environment variables and a dedicated compiler home to the worker. It does not receive the app's setup token or GitHub credentials. Only fixed language requests are exposed; arbitrary LSP commands and filesystem paths are not accepted from the browser. The upstream preview listener stays on loopback behind a same-origin, authenticated WebSocket proxy, with access checked again while connected. The pinned bundled renderer runs in an iframe with its own nonce-based CSP; the application's script policy remains unchanged.

There are at most three native live workers per installation and two per account. Navigation, sign-out, access removal, server shutdown, or idle expiry releases workers and temporary mirrors. The Mac worker still runs with the current Unix user's privileges, without an OS sandbox or per-worker memory/CPU limits. This integration is disabled for Linux/shared compiler-service deployments, which retain their existing compilation sandbox.

Only project owners may configure or trigger GitHub backups. Tokens arrive in authenticated, same-origin request bodies and are used for GitHub API requests. With Remember enabled, each account’s token is stored in macOS Keychain, scoped to this installation; Linux uses a 0600 file under private `data/.github-tokens/` (0700 directory), accessible to the service’s OS account. Tokens are never returned by the credential API, stored in SQLite/browser storage, or included in source snapshots. The account may forget its token; forgetting does not revoke it on GitHub. Tokens can also be used only in tab memory with Remember unchecked. Backup configuration and commit identifiers are stored separately from source. Snapshots exclude the application database and local build output. GitHub permissions and repository visibility control access to backed-up source. Branches are updated without force; local data remains on errors.

LaTeX preview PDFs are rendered by the pinned, locally served PDF.js library with JavaScript evaluation and XFA disabled. SyncTeX input is size/record bounded and retains only source paths present in that compiled project, without host filesystem paths. Maps require the same project read access as PDFs and match a specific build timestamp. Only source messages from the active same-origin preview iframe, matching the current project/build and an existing project file, can move the editor. Permanent project deletion clears mapping rows too. PDF.js release assets have recorded checksums and upstream license notices; no CDN is used at runtime.

Appearance stores only a fixed palette identifier and `light`, `dark`, or `system` in browser localStorage. It does not store account details or GitHub credentials. Documentation screenshots use disposable fictional accounts and starter documents; generated invitation links and populated token fields must never appear in published images.

Deleting a project moves it to owner-only Trash for 30 days. Trashed projects are excluded from normal access, compilation, live sessions, invitations and GitHub backup selection; active workers are released and pending invitations revoked. Restore retains prior files, history and membership. Expired projects cannot be restored and are purged on startup and periodic server cleanup. Permanent deletion clears the project’s source, history, build, membership, location and backup-status rows, without deleting remote GitHub backups. Trash remains inside the existing 25-owned-project quota.
