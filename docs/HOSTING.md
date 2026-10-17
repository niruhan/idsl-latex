# Hosting options

This guide covers shared **Linux** hosting. Start with [Linux installation](INSTALL_LINUX.md) if the app is not installed yet. For a personal macOS workspace, use [the local guide](LOCAL.md); its runner supports local-only access. Project browsing, the Typst sample, and themes are available in both interfaces. Linux compiler isolation still needs `./labtex doctor` to pass on the target host.

## Private access over SSH

Keep the app in local mode:

```bash
./labtex start --local
```

Members who already have SSH access can forward the same port from their own computers:

```bash
ssh -N -L 8765:127.0.0.1:8765 YOUR_USER@YOUR_SERVER
```

For an SSH jump host, add `-J YOUR_JUMP_USER@YOUR_JUMP_HOST`. Open `http://127.0.0.1:8765` and use the app login. App membership does not grant SSH accounts. Invitations must contain this same loopback origin for this mode. With multiple SSH users, local HTTP connections share the loopback rate-limit bucket.

## Temporary public URL

After creating the administrator, `./labtex start --public` manages the connector automatically. It needs outbound HTTPS access but no inbound backend port. Run `./labtex url` to get the endpoint and `./labtex stop` to close it. Each new connector session gets a new hostname. Read the [Quick Tunnel limitations](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) before relying on this for a group.

## Stable domain with a reverse proxy

For a persistent service, use a domain you control and a maintained HTTPS reverse proxy, or a named Cloudflare Tunnel. Set up the administrator over SSH first, then configure the app's public origin:

```bash
./labtex start --origin https://latex.example.org
```

This turns off the built-in Quick Tunnel, keeps the backend on loopback, and sets strict Host/Origin checks plus Secure cookies. It **does not** create DNS records, certificates, a reverse proxy, or a named tunnel. Configure those separately on your chosen host.

For example, a Caddy instance on the same host can use:

```caddyfile
latex.example.org {
    reverse_proxy 127.0.0.1:8765
}
```

Replace the example hostname everywhere. Caddy must be able to provision certificates, and DNS/firewall routing must match your deployment. The upstream Host header must remain the public hostname. Do not expose port 8765 publicly. If the proxy runs inside a container, its `127.0.0.1` is a different network namespace; arrange an appropriate protected connection rather than rebinding the app to all interfaces.

For a named Cloudflare Tunnel, route your public hostname to `http://127.0.0.1:8765` on the same host and preserve the public Host header. Keep tunnel credentials outside this repository and follow [Cloudflare's setup documentation](https://developers.cloudflare.com/tunnel/get-started/). The repository does not include a tunnel credential or perform this account-specific provisioning.

Custom proxy mode does not trust arbitrary client-IP headers. Authentication rate limits therefore group requests under the proxy's address. Add suitable rate limits and optionally an identity/access gateway at the proxy. Test account signup, login, PDF compilation, and backups before inviting your group.

The installer checks and has been exercised on Ubuntu 22.04 with Bubblewrap 0.6.1. Distribution namespace restrictions vary; `./labtex doctor` must pass on your host. The Caddy/named-tunnel examples are configuration guidance, not part of the automated trial-URL provisioning.
