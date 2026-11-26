# CLIProxyAPI on the VPS

[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) runs as the
`cli-proxy-api` container (plugin `cliproxyapi`).

| Path | Who reaches it | Source IP seen | Management API |
|---|---|---|---|
| Tailnet → `<box>:8317` | tailnet peers (API clients) | `100.x` | blocked (`allow-remote: false`) |
| Cloudflare tunnel → `localhost:8317` | you, behind Cloudflare Access | `127.0.0.1` | allowed (secret key) |
| Public IP `:8317` | nobody | — | UFW drops it |

The container uses **host networking** so the app sees real source IPs. In
bridge mode every request would come from the Docker gateway and the
local/remote split above would not work.

Don't set `MANAGEMENT_PASSWORD` in the container environment — it forces
remote management on.

## State (VPS only, never synced)

```
/home/deploy/.cliproxyapi/
  config.yaml   # server.host "", port 8317, management.allow-remote: false
  auths/        # OAuth token files (mounted at /root/.cli-proxy-api)
  logs/
```

Deploy never touches this directory. Edit `config.yaml` on the VPS (or via
the management UI); the app hot-reloads it.

## First-time setup

1. Copy a config (and optionally existing auth files) to the VPS:
   ```bash
   scp -P <port> config.yaml auths/*.json <admin>@<vps>:/tmp/cpa/
   ./stack-cli ssh -c 'sudo mkdir -p /home/deploy/.cliproxyapi/auths && \
     sudo mv /tmp/cpa/config.yaml /home/deploy/.cliproxyapi/ && \
     sudo mv /tmp/cpa/*.json /home/deploy/.cliproxyapi/auths/'
   ```
   Set `management.allow-remote: false` and keep `access.api-keys` set.
2. Enable the plugin (`plugins.cliproxyapi: {}`) and tailnet port
   (`plugins.tailscale.ports: [8317]`), then `./stack-cli deploy`.
3. Cloudflare Zero Trust → Tunnels → this tunnel → Public Hostname:
   `cliproxy.<domain>` → HTTP `localhost:8317`, plus a self-hosted Access
   app for that hostname. UI: `https://cliproxy.<domain>/management.html`.

## Clients

Point OpenAI/Anthropic-compatible clients at `http://<box-tailnet-name>:8317`
with one of the `access.api-keys`.

## OAuth login on the VPS

Login callback ports (8085, 1455, 54545, …) listen on the host but UFW blocks
them. Forward the one you need over SSH while logging in, e.g.:

```bash
ssh -L 54545:127.0.0.1:54545 -p <port> <admin>@<vps>
docker exec -it my-vps-cli-proxy-api ./CLIProxyAPI --claude-login --no-browser
```

Sharing one account's auth file between two running proxies can log one
out when the refresh token rotates.

## File permissions

Deploy keeps secrets out of reach of other local users:

- `/home/deploy` is 750. Every deploy read of it uses `sudo` (the SSH admin user is not in the app user's group).
- `.cliproxyapi/` is 700 and `auths/*` files are 600.
- Backups (`backups/`) are owner-only; deploy re-applies `go-rwx` each time.
- Cron `env:` values (for example the Telegram token) are never put in `/etc/cron.d`. They live in
  `crons/env.d/<cron>.env` (owned by the cron's user, 600) and the cron line sources that file.

The app user can still read what it owns. Splitting deploy and runtime accounts is planned.

## usage-server (optional)

[simple10/usage-server](https://github.com/simple10/usage-server) is a token
usage and cost dashboard. A proxy plugin (`usage-server.so`) writes a spool
folder. The `usage-server` container reads the spool and Claude Code
transcripts. Enable it with `plugins.cliproxyapi.usageServer` (see
`stack.yml.example`). This adds the `usage-server` service and two extra mounts
on `cli-proxy-api` (`plugins/` read-only, `usage-spool/`). Removing the block
drops the service and the mounts. The proxy still runs; it just loses usage
tracking.

### What deploy does

All of it runs on the VPS as the app user (`deployuser`). This machine needs
only ssh. The VPS needs docker, git and network access (GitHub, Docker Hub,
ghcr.io, PyPI).

1. **post-sync:** makes `.cliproxyapi/plugins`, `.cliproxyapi/usage-spool`,
   `.usage-server/data`. Creates `.usage-server/usage-server.env` with random
   tokens **only if it is missing**.
2. **build:** checks the version guard (below). If the pinned image
   `usage-server:<version>` is missing, it clones the repo at tag `v<version>`
   into `.usage-server/src` and runs `scripts/build-host.sh`. If the plugin is
   missing or older than the pin, it builds and installs
   `.cliproxyapi/plugins/usage-server.so` and records the version in
   `.usage-server/plugin.version`.
3. **start:** compose starts the sidecar (the image exists by now). A build
   failure stops the deploy before start, so the proxy is never touched.

An installed `.so` with an unknown version (hand-installed, never loaded) is
left alone, and deploy prints how to record or replace it.

### What deploy never does

- **Edit the proxy's `config.yaml`.** The proxy rewrites it when you change
  settings in the management UI, so a pushed copy would lose changes. Deploy
  checks whether the `usage-server` block is there and the bridge token matches
  `usage-server.env`. If not, it prints the exact commands (backup,
  `edit_config.py check`/`enable`, restart) to run on the VPS.
- **Restart the proxy.** After a new plugin build, deploy prints the restart
  command. Run it when a short outage is fine.

### Pin and updates

The pinned release is `USAGE_SERVER_PIN` in
`cli/plugins/cliproxyapi/usage-server-pin.ts`. Update it:

```bash
bun run bump-usage-server            # newest vX.Y.Z tag on GitHub
bun run bump-usage-server 0.2.0      # a specific tag
bun run bump-usage-server --commit   # also commit
```

Then `./stack-cli deploy` builds the new tag on the VPS. Cut a release in the
usage-server repo with `just release X.Y.Z` (or `scripts/release.sh X.Y.Z`).

**Version guard.** If you change usage-server on the VPS (new image tag, newer
plugin), deploy compares the newest version it finds there (running image
label, local `usage-server:*` tags, the plugin's status file, the install
marker) with the pin. If the VPS is newer, deploy warns that continuing runs
the older pinned version. Bump the pin to match. Edits made without a version
bump are not detected.

To force a rebuild of a pinned version: `docker rmi usage-server:<version>` (and
remove `usage-server.so` for the plugin), then deploy.

### VPS-only files (deploy never syncs or deletes them)

| Path | What |
|---|---|
| `.cliproxyapi/plugins/usage-server.so` | the plugin (built by deploy) |
| `.cliproxyapi/usage-spool/` | spool (mode 755) |
| `.usage-server/usage-server.env` | `USAGE_BRIDGE_TOKEN`, `USAGE_API_TOKENS` (mode 600); in the `cliproxyapi` backup set |
| `.usage-server/data/` | `usage.db` (can be rebuilt from the spool and transcripts) |
| `.usage-server/src/` | git checkout of the pinned tag (deploy refuses to touch it if it has local changes) |
| `.usage-server/plugin.version` | version of the installed plugin |
| `plugins:` block in `.cliproxyapi/config.yaml` | enables the plugin (manual, see above) |

`uid`/`gid` must belong to a user that can read `transcriptsDir` (for example
`deployuser`, 1002).
