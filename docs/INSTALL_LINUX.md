# Linux installation

Use an **x86_64 Linux host** with Python 3.10+, systemd user services, cgroup v2, and unprivileged Bubblewrap namespaces. The earlier Linux deployment was exercised on Ubuntu 22.04; run `./labtex doctor` on your target host.

The following instructions are for **shared Linux hosting**. For a personal Mac installation, use [the macOS guide](LOCAL.md).

Allow at least **7 GiB free disk space during installation**, about **3 GiB afterward**, and **3 GiB RAM**. The service has a 2 GiB memory limit and uses `/dev/shm` for temporary builds. Setup downloads about 2.9 GB once so compilation can run without network access.

### 1. Install prerequisites

On Ubuntu/Debian:

```bash
sudo apt update
sudo apt install -y python3 bubblewrap ca-certificates fontconfig fonts-dejavu-core git
```

Run the remaining commands as your regular user, **without sudo**. Prefer a dedicated account with no SSH keys, cloud credentials, or unrelated research data.

### 2. Get the app and install the compiler

```bash
git clone https://github.com/niruhan/idsl-latex.git
cd idsl-latex
./labtex setup
./labtex start
```

You can also download the [current source ZIP](https://github.com/niruhan/idsl-latex/archive/refs/heads/main.zip), or a tagged version from [Releases](https://github.com/niruhan/idsl-latex/releases), extract it, and run `python3 labtex setup` followed by `python3 labtex start` inside the extracted folder. Use `python3 labtex` instead of `./labtex` if your ZIP extractor does not preserve executable permissions.

Setup downloads pinned versions of Typst, Tectonic, and the TeX package bundle, checks SHA-256 digests, prepares the offline compiler, and checks both isolation and actual PDF compilation. There is no Python virtual environment, npm build, database server, or Conda environment to configure. It does not change firewall rules or bind a public port.

### 3. Create your administrator account

Open **http://127.0.0.1:8765** on the host, and retrieve the one-time setup token:

```bash
./labtex setup-token
```

Paste the token into the first-account form and choose your own name, email, and password (at least 12 characters). This first account is the administrator. There are no default credentials. The token cannot create more accounts after setup.

If the host is a remote server, run this command **on your laptop**, then open the same local URL in your laptop browser:

```bash
ssh -N -L 8765:127.0.0.1:8765 YOUR_USER@YOUR_SERVER
```

If that port is already occupied on the host, start with `./labtex start --port 8877` and substitute `8877` throughout the browser URL and SSH tunnel command.

### 4. Invite members

In the app:

1. Open **Account → Approved emails**, add the members' addresses, and save.
2. Open **Account → Invite lab members** and generate links. The default batch is three.
3. Send one link to each intended member through a trusted channel. Each link expires after seven days and works once.
4. Members enter an approved address and choose their own password. Each gets a private starter project; their first project-home visit adds the Typst sample when there is room under the project limit.

Email addresses identify accounts; **email ownership is not verified**. Treat an unused invitation like a temporary password. Anyone holding one could claim an unused approved address. Do not post invitations publicly. You can revoke unused invitations in the same panel. Removing an approved address revokes that member's sessions and login access, while retaining their documents.

The **Share** button inside a project has a different purpose: it grants an existing account editor/viewer access to that project. It does not create an account or expose the owner's other projects. The administrator manages membership but has no special access to other users' documents through the app. The server operator can access the database.

## Share a public HTTPS URL

This feature is part of the Linux runner. For personal Mac use, keep the loopback-only local runner.

After creating the administrator locally:

```bash
./labtex start --public
./labtex url
```

This downloads the pinned Cloudflare connector and creates a temporary HTTPS URL. Share the base URL for existing members to sign in; create new invitation links after switching from local to public access so they contain the current hostname.

The connector makes an outbound connection to Cloudflare and forwards requests to `127.0.0.1:8765`. You do not need a domain, Cloudflare account, public listening port, or router port forwarding. Cloudflare terminates HTTPS and processes the proxied traffic; use hosting arrangements that fit your documents' privacy requirements.

The login page is publicly reachable. Authentication and invitations control access to accounts and documents. A hidden URL is not an access control.

[Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) are intended for trials and have no uptime guarantee. The hostname changes when the connector restarts, including service restarts. Existing accounts and files remain, but old links point at the old hostname. Revoke unused old invitations and issue new ones. For ongoing use, see [a stable domain or private network](HOSTING.md).

To return to local access:

```bash
./labtex start --local
```

## Everyday commands

Commands use the platform-specific runner. Exposure and service-management commands below are Linux-only; see [the Mac command reference](LOCAL.md).

| Command | Purpose |
| --- | --- |
| `./labtex start` | Start locally on Mac; start/restart the saved exposure mode on Linux |
| `./labtex start --public` | Enable a temporary public HTTPS URL |
| `./labtex start --local` | Stop the tunnel and use loopback HTTP |
| `./labtex status` | Show whether the app is running; Linux also shows service resources |
| `./labtex url` | Print the last generated URL; check status if it is unreachable |
| `./labtex stop` | Stop this installation, retaining accounts and documents |
| `./labtex doctor` | Compile real LaTeX and Typst samples; Linux also checks isolation |
| `./labtex test` | Run the automated backend and sandbox tests using temporary databases |
| `./labtex logs` | Show recent private logs; redact before sharing |
| `./labtex uninstall-service` | Remove the service, retaining your data and source |

On Linux, `start` installs an enabled systemd **user** service with a name unique to this installation folder. To keep it running after logout and start it at boot, have the server administrator enable lingering once:

```bash
sudo loginctl enable-linger "$USER"
```

Keep the installation folder in place while running. On Linux, uninstall its service before moving the folder. On Mac, stop the app before moving it. Run setup and start again from the new location.


## Troubleshooting

**Bubblewrap / namespaces unavailable:** the installer stops rather than running an unsandboxed compiler. Some distributions or container hosts restrict unprivileged user namespaces. Ask the host administrator for a supported, narrowly scoped configuration, or use a compatible Linux VM. Do not disable the sandbox or globally weaken kernel security settings to bypass the check.

**Cannot connect to the user bus:** use a normal login/SSH session for the intended service account on a systemd host. Do not run the app under `sudo` or inside a container without a systemd user manager.

**A compile fails:** read the build log in the app, check that the correct main `.tex` or `.typ` file is selected, and run `./labtex doctor`. Unsupported external tools or missing packages may require adapting the project.

**The public page fails after restart:** run `./labtex status`, `./labtex logs`, and `./labtex url`. Wait for the new tunnel to become ready and use its current URL. Check outbound HTTPS connectivity; do not open the backend port to the internet.


For database backups, updates, and account recovery, see [operations](OPERATIONS.md). For source backups on GitHub, see [the backup guide](LOCAL.md#github-backups).
