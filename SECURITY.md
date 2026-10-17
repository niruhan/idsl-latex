# Security

This is an invite-only application intended for small, trusted groups. It is not a hardened public compile farm. Report suspected vulnerabilities privately through this repository's **Security → Report a vulnerability** tab. Do not attach real documents, credentials, invitation links, databases, or server logs to a public issue.

## Boundaries

The supported launcher runs the backend inside a Bubblewrap filesystem with read-only application and runtime mounts, a writable database directory, and private temporary build storage. Other home directories, host configuration, SSH keys, and private deployment logs are not mounted. The backend retains host networking so it can serve the loopback listener. A compromised backend could still make outbound or local network connections and read the app database.

Every compilation runs in an additional namespace with no host network, no host home directories, a cleared environment, a read-only TeX installation, and only that compilation's files writable. Tectonic runs in untrusted mode with shell escape disabled. The compiler has memory/output/time limits; the whole service has a 2 GiB memory limit, no swap allowance, one CPU quota, and a task limit.

These controls share the host kernel. They do not eliminate kernel, parser, runtime, supply-chain, or application vulnerabilities. Run public installations in a dedicated VM/account with no unrelated credentials or sensitive mounts. Do not run the launcher as root. Other processes running under the same Unix account are trusted and can read that account's app data. The app cannot protect its database from the server operator.

## Authentication and admission

- First setup requires a freshly generated private bootstrap token. There are no shipped accounts, passwords, or live invitation tokens.
- Passwords use salted PBKDF2-HMAC-SHA256 with 600,000 iterations. Session tokens and invitations are random and stored hashed. Sessions expire after seven days.
- Cookies are HttpOnly, SameSite=Strict, and Secure for HTTPS origins. Requests validate Host and Origin; the frontend uses a restrictive content security policy.
- Account invitations are single-use, expire after seven days, and require an exact approved address. Email ownership is **not** verified. Link possession authorizes signup; distribute links privately.
- Project permissions are checked on each request. Account administration does not grant document access through the UI/API.
- Request concurrency, body sizes, authentication attempts, uploads, build queues, history, and per-account project counts are bounded. These are availability mitigations, not a complete denial-of-service defense or global disk quota.

## Hosting

The backend listens only on `127.0.0.1`. Quick Tunnels expose the login page through an outbound Cloudflare connection. Public HTTPS does not make an app immune to attacks. Cloudflare sees proxied traffic. Restrict accounts and invitations, keep the OS current, and prefer private network access where appropriate.

The Cloudflare client-IP header is trusted only in the bundled Quick Tunnel mode. In custom reverse-proxy mode it is not trusted; authentication throttling groups clients by the proxy's loopback address. Add rate limiting/access controls at your proxy for larger deployments. Never expose the raw backend port or rely on a secret hostname.

## Private files and updates

Never commit or upload `data/`, `.local/`, backups, `.env` files, logs, browser artifacts, or your whole installed folder. Source archives must come from Git's tracked files. Public tests use fictional `example.test` accounts and test-only password strings that do not grant access to any shipped or hosted account.

Installers check pinned SHA-256 hashes for public dependencies before using them. This detects corrupt or changed downloads, but is not an independent guarantee of upstream integrity. Review upstream security releases and update `deploy/dependencies.json` deliberately. The package bundle is pinned for reproducibility and may not contain recent packages. Tectonic is MIT-licensed; cloudflared is Apache-2.0; the TeX bundle includes packages under multiple licenses.

Only the latest published release is maintained. Back up before upgrading. If a real credential is accidentally published, revoke/rotate it immediately; deleting the current file alone does not remove it from Git history, clones, or caches.

## Personal macOS mode and GitHub backups

The Mac local runner binds to loopback and runs compilers as the current user, using a dedicated compiler home, Tectonic untrusted mode, Typst project-root limits, and bounded builds. It does not provide Bubblewrap/cgroup isolation. Use it for trusted personal projects; keep shared/public hosting on Linux. See [local mode](docs/LOCAL.md).

Only project owners may configure or trigger GitHub backups. Tokens are supplied per browser session in request bodies, used only for requests to the fixed GitHub API hostname, and never persisted. Backup configuration and commit identifiers are stored separately from source. Snapshots exclude the application database and local build output. GitHub permissions and repository visibility control access to backed-up source. Branches are updated without force; local data remains on errors.
