# Preferred VPS layout

One admin, one stack owner, and any number of dev accounts. New boxes should copy
this layout, not the older "one app user does everything" layout.

```
 admin (SUDO_USER)          stack owner (APP_USER)           dev accounts (DEV_USERS)
 sudo + SSH key             docker group (ROOT-EQUIVALENT)   rootless Docker, no sudo
 runs deploys, humans       no shell, no SSH, no password    agents, developers, test runners
        │                   owns the stack files                    │
        └── sudo -u ───────────────▶  root Docker daemon            └── own daemon, own socket
                                      (proxy, tunnel, services)         (qdrant, tests, builds)
```

| Role | Example name | Login | `sudo` | Docker | Owns |
|---|---|---|---|---|---|
| Admin | `adminroot` | SSH key | yes | via `sudo` | nothing day to day; deploys and fixes |
| Stack owner | `stackroot` | none (`nologin`, locked) | no | root daemon (`docker` group) | the machine root (`/srv/airstack`), `.cliproxyapi`, cron env files, state |
| Dev account | `deployuser` | none; admin runs `sudo -iu deployuser` | no | its **own rootless** daemon | its home, Homebrew, project checkouts |

## Why

A user in the `docker` group is root: `docker run -v /:/host ...` reads any file and
rewrites `/etc`. Permission bits on files do not stop it. So:

- Only one account holds the root daemon, and nobody can log in as it. The admin reaches it
  with `sudo -u stackroot docker compose ...`. This is what deploy does (`APP_USER`).
- Agents and developers get Docker too, but a rootless one: root inside their containers is
  just their own user on the host, so an escape gains nothing.
- The stack's files are owned by the stack owner (mode 750, no shared group), so dev accounts
  cannot read tokens, `config.yaml` or cron env files.

The stack owner is still root-equivalent. Keep it unreachable: never give it a shell, an SSH
key, a password or `sudo`.

## Set up

In `.env`:

```
SUDO_USER=adminroot
APP_USER=stackroot          # stack owner
DEV_USERS=deployuser        # space-separated; more accounts allowed
BREW_OWNER=deployuser       # optional, see Homebrew
```

```bash
./stack-cli vps-setup base       # creates the three kinds of account
./stack-cli vps-setup harden ... # as usual
./stack-cli vps-setup docker     # root Docker; only APP_USER joins the docker group
./stack-cli vps-setup rootless   # a rootless daemon for each dev user
./stack-cli vps-setup brew-shim  # optional: one Homebrew owner
./stack-cli vps-setup verify     # warns about anyone else in the docker group
```

Dev users run plain `docker`; their default context points at their own daemon.
Rootless limits: containers cannot reach the host's `127.0.0.1` (publish ports and use them),
"host" networking is the daemon's private namespace, and ports under 1024 need a sysctl.
Published ports bind `127.0.0.1` by default (`daemon.json` `"ip"`).

## Where deploys go

| Path | What | Owner / mode |
|---|---|---|
| `/srv/airstack/` | machine root (`root:` in the machine file; default) | stack owner, 750 |
| `/srv/airstack/machine/` | machine unit: compose project `airstack` (cloudflared), host crons | stack owner, 750 |
| `/srv/airstack/stacks/<instance>/` | stacks run by the stack owner (root daemon) | stack owner, 750 |
| `/home/<devuser>/airstack/<instance>/` | stacks run by a dev user (rootless daemon) | that dev user, 750 |
| `/etc/airstack/machine.yaml` | node marker: machine, roles, paths, deployed instances | root, 644 |
| `/etc/cron.d/<project>_*`, `/etc/stacks/<project>.env` | crons and per-instance manifests | root, 644 |

`/srv` is the filesystem-standard place for data a host serves; `/home` stays for people. Deploy
syncs as the admin, then `chown -R`s each unit to its run user. The stack owner's own home is
`/var/lib/<stack user>` (Docker and git need a writable `HOME`). Dev-user stacks cannot live under
the machine root (it is closed to them); `airstack fleet check` enforces that.

Rules that keep the layout honest:

- Everything root or the stack owner executes lives under paths the dev accounts cannot write.
  Never put a dev-owned directory (for example Homebrew) on their `PATH`.
- Deployed secrets go in files owned by the stack owner or root, mode 600 (cron `env:` values
  are written to `crons/env.d/`, never to `/etc/cron.d`).
- Anything loaded into a root-daemon container from a dev-writable path (a plugin `.so`, a built
  image) is code the dev accounts control. Build such things as the stack owner from a pinned
  source, as the usage-server plugin does.

## Homebrew

Homebrew is single-owner. A group-writable install lets any member swap binaries other users run,
so instead:

- `BREW_OWNER` (a dev user) installs and updates packages.
- Other interactive accounts get `.../.linuxbrew/bin` at the **end** of `PATH` (they run the tools)
  and a `/usr/local/bin/brew` shim that refuses `install`, `upgrade` and the like with a message:
  ask the admin, do not reinstall Homebrew. Read-only commands (`list`, `info`, `--prefix`, ...) work.
- The stack owner and root get no Homebrew `PATH` at all.

If an account must not trust the Homebrew owner's binaries, give it apt packages instead (older, but
root-owned). `cibroker-admin`-style accounts are left out of the shim until they are set up on purpose.
