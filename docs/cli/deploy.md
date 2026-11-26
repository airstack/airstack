# deploy

`deploy` puts the fleet config on machines and starts the containers. With `--install`, it first
sets up a fresh box. It is a controller verb. It needs a fleet.

## Usage

```
airstack deploy <machine>... | '<pattern>' | --all [options]
airstack deploy <machine> --install [--step <step> [--finalize]]
airstack deploy --help
```

You must name at least one machine, a quoted pattern (for example `'web-*'`), or `--all`. Put
quotes around a pattern: zsh stops the whole command, or expands the pattern, when it is not
quoted.

## Options

| Option | Meaning |
|---|---|
| `<machine>...` | Deploy these machines. Patterns with `*` work. |
| `--all` | Deploy all machines. |
| `--stack <instance>` | Deploy only this stack instance. The machine unit always deploys too. |
| `--stage` | Render the files into `.airstack/deploy/<machine>/` only. Connects to no machine. |
| `--dry-run` | Sync the files and validate the compose file on the machine. Do not start containers. |
| `--force` | Recreate all services (`docker compose up --force-recreate`). Overwrite box edits (they stay in the machine's config history). |
| `--prune` | Stop instances that were removed from the machine file. Keeps their directories. |
| `--install` | First-time setup of a fresh box, then a normal deploy. See [Install sequence](#install-sequence). |
| `--adopt` | Take over a machine that is already set up. See [Adopt a machine](#adopt-a-machine-that-is-already-set-up). |
| `--step <step>` | With `--install`: run one setup step only. Steps: `base`, `harden`, `reboot`, `docker`, `rootless`, `brew-shim`, `tailscale`, `verify`, `lockdown`. |
| `--finalize` | With `--step harden`: close the bootstrap SSH port. `--install` does this itself. |
| `--undo` | With `--step lockdown`: open the public SSH port again. |
| `-v`, `--verbose` | Write phase-by-phase output to the deploy log. |
| `-h`, `--help` | Print the usage. |

Rules:

- `--stage` and `--dry-run` cannot be used together.
- `--step` needs `--install`.

## Terms

- **Unit**: one deploy target on a machine. Each machine has one **machine unit** (compose project
  `airstack`, in `<root>/machine/`) and one unit per **stack instance**.
- **Box edit**: a change that someone made to a deployed file directly on the machine.
- **Marker**: `/etc/airstack/machine.yaml` on the machine. It makes the machine a node.

## What deploy does

For each machine, one machine after the other:

1. Load and check the machine config (the same checks as `airstack fleet check`). Stop on a
   config error.
2. Check that the machine is a node (it has the marker). If not, stop with
   `-> airstack deploy <machine> --install`.
3. Create the machine root (`/srv/airstack` by default), owned by the stack owner, mode 750.
4. Put the pinned airstack version on the machine (see [versions.md](versions.md)).
5. Write `/etc/airstack/redact.json`, the group `airstack-admin` and `/etc/sudoers.d/airstack`.
6. Write the marker again.
7. Deploy each unit through the deploy pipeline (below).
8. Report removed instances. With `--prune`, stop them.

A failed machine does not stop the others. With more than one machine, deploy prints a summary
line per machine at the end.

### The deploy pipeline (per unit)

| Phase | What happens |
|---|---|
| pre-stage | Check that `.airstack/` is gitignored. |
| stage | Render templates and plugin files into `.airstack/deploy/<machine>/<unit>/`. Write the list of managed files. |
| pre-sync | Check that SSH works. The **drift guard** runs here. |
| sync | `rsync` the staged files to the unit's install directory. |
| post-sync | Set owner and mode (750). Move `/etc` files into place. Record the deploy in the config history. |
| build | Build images (plugins only). |
| pre-start | Decide which services to start or recreate. |
| dry-run | Validate the compose file on the machine. `--dry-run` stops here. |
| start | `docker compose up -d` as the unit's run user. |
| healthcheck | Plugin health checks. |
| post-deploy | Plugin checks, for example the Cloudflare Access guard. |
| validate | Plugin validation. |

`--stage` stops after the stage phase.

## Adopt a machine that is already set up

Use `--adopt` for a machine that is hardened and runs Docker already, for example a machine
that an older tool set up. It does not run the setup scripts again.

```console
$ airstack deploy web-1 --adopt
ok   web-1: sudo without a password
ok   web-1: user adminroot exists
ok   web-1: docker answers
...
ok   web-1: wrote /etc/airstack/machine.yaml
ok   web-1: airstack installed 0.1.0
->   airstack deploy web-1   (deploys the units)
```

1. It connects as `host.ssh.user` on `host.ssh.port`.
2. It checks, read only: passwordless sudo, the users in `host.users`, Docker and the compose
   plugin, rsync and git, UFW (warning only), rootless Docker of each dev user (warning only).
3. When a check fails, it stops. Nothing on the machine changed.
4. Then it writes `/etc/airstack/machine.yaml`, puts the airstack build on the machine, and
   creates the machine root. It never starts, stops or changes containers.
5. A machine that already has the marker is left alone.

Run a normal `airstack deploy` next to deploy the units.

## Install sequence

`airstack deploy <machine> --install` takes a fresh box to a finished, locked-down node. The
machine file describes the **finished** machine:

- `host.ssh.user` and `host.ssh.port` (default `222`): how you connect after setup.
- `host.ssh.bootstrapUser` (default `root`) and `host.ssh.bootstrapPort` (default `22`): how a
  fresh box answers.

Before each step, airstack tries these connections and uses the first that works:

1. `ssh.user` on `ssh.port`.
2. `ssh.user` on `ssh.bootstrapPort`.
3. `ssh.bootstrapUser` on `ssh.bootstrapPort`.

The sequence:

1. `base`: packages and users (admin, stack owner, dev accounts). When the machine has no
   `SUDO_USER_PASSWORD` secret, airstack makes one and saves it in
   `.airstack/secrets/<machine>.jsonc`.
2. `harden`: SSH and firewall settings. Opens `ssh.port`. The bootstrap port stays open.
3. `docker`: the root Docker daemon. Only the stack owner joins the `docker` group.
4. `rootless`: a rootless Docker daemon for each dev account. Only when `host.users.dev` is not
   empty.
5. `verify`: check the setup.
6. When `ssh.port` is the same as `ssh.bootstrapPort`, the install stops here. No lockdown.
7. Check that SSH works on `ssh.port`. If not, stop. The bootstrap port stays open.
8. `reboot`: restart the machine and wait for SSH on `ssh.port`.
9. `harden --finalize`: close the bootstrap port. Only the admin may log in.
10. Check that `ssh.port` works and the bootstrap port refuses.
11. Write `/etc/airstack/machine.yaml`.
12. Run a normal deploy.

Each step is safe to run again. If a step fails, fix the cause and run `--install` again.

The steps `brew-shim`, `tailscale` and `lockdown` are not part of `--install`. Run them with
`--step`:

| Step | What it does |
|---|---|
| `brew-shim` | One Homebrew owner (`host.users.brewOwner` or the first dev account); a `brew` shim for the other accounts. |
| `tailscale` | Install Tailscale and log in. |
| `lockdown` | Close the public SSH port. SSH then works only through the Cloudflare tunnel. Needs `host.ssh.expose: tunnel` and `host.ssh.tunnelHostname`. |

`--step` runs one step and does not write the marker or deploy.

## Drift guard and --force

Before deploy writes a unit, it asks the node which files on the machine have box edits. For each
file deploy will write:

| Live file on the machine | Result |
|---|---|
| Same as the new file | Nothing to lose. |
| Same as the last deploy | No box edit. Deploy overwrites it. |
| Same as your last `airstack pull` | You saw this box edit. Deploy overwrites it. |
| Something else | **Conflict.** Deploy would lose a box edit that nobody pulled. |

On a conflict, deploy refuses the unit:

```
fail web-1/hello: pre-sync: box edits would be lost: compose.yaml. Run `airstack pull <machine>` and put the edits in the fleet repo, or deploy with --force (the edits stay in history).
```

You have two choices:

1. Keep the edit:
   1. Run `airstack pull web-1`.
   2. Put the edit into the fleet repo (template or values).
   3. Run `airstack deploy web-1` again.
2. Drop the edit: run `airstack deploy web-1 --force`. The edit stays in the machine's config
   history. You can get it back with `airstack machine rollback` (see [machine.md](machine.md)).

When the node has no airstack with config history yet, the guard warns and deploy continues.

## Cloudflare Access guard

When the machine uses the `airstack/cloudflare` plugin, deploy checks every public tunnel hostname
after cloudflared starts. **Cloudflare Access** is a Cloudflare login page in front of a
hostname.

1. airstack reads the live tunnel routes from cloudflared on the machine (`127.0.0.1:20241`).
2. airstack sends one request to each hostname from the controller, without a login.
3. airstack sorts each route:
   - **protected**: a redirect to the Cloudflare Access login, or the Access 403 page.
   - **unknown**: no answer, a DNS error, or a Cloudflare 5xx error.
   - **unprotected**: anything else (the app answered).

Settings in the machine file:

```yaml
plugins:
  airstack/cloudflare:
    tunnelToken: ${CLOUDFLARE_TUNNEL_TOKEN}
    access:
      required: true          # default true: every public hostname needs Access
      exempt: [hooks.example.com, app.example.com/webhook]   # public on purpose
      onDeploy: refuse        # refuse (default) | warn
      onScan: alert           # alert (default) | stop
```

| Setting | Result for an unprotected route that is not exempt |
|---|---|
| `onDeploy: refuse` | Deploy stops cloudflared and fails. The message names each route. |
| `onDeploy: warn` | Deploy keeps the tunnel up and adds a warning. |
| `onScan: alert` | The 15-minute `host_alerter` check sends an alert. |
| `onScan: stop` | The 15-minute check stops cloudflared and sends "tunnel stopped". The next deploy starts it again (and refuses again if the route is still public). |

An **unknown** route only warns. It never stops the tunnel. With `required: false`, the guard
reports and never refuses.

```
fail web-1/airstack (machine): post-deploy: Cloudflare Access: PUBLIC without Access: app.example.com (HTTP 200 → http://hello-whoami:8080); cloudflared is stopped. Add an Access application for the hostname, or list it in access.exempt, then deploy again.
```

## Removed instances and --prune

The marker lists the instances that deploy put on the machine. When an instance is no longer in
the machine file, deploy warns on every run:

```
warn web-1/hello-dev: removed from the machine file but still deployed (/home/deployuser/airstack/hello-dev)
->   airstack deploy web-1 --prune
```

`--prune` runs `docker compose down` for the instance, removes its cron files and manifest, and
keeps its install directory.

## Examples

Deploy one machine:

```
$ airstack deploy web-1
ok   web-1: airstack up to date: 0.1.0
ok   web-1/airstack (machine): deployed
ok   web-1/hello: deployed
ok   web-1/hello-dev: deployed
```

Set up a fresh box (output shortened):

```
$ airstack deploy web-1 --install
web-1: setup base (as root, port 22) …
ok   web-1: setup base
web-1: setup harden (as adminroot, port 22) …
ok   web-1: setup harden
…
ok   web-1: locked down: SSH only on port 222 as adminroot; port 22 closed
ok   web-1: wrote /etc/airstack/machine.yaml
ok   web-1: airstack installed 0.1.0
ok   web-1/airstack (machine): deployed
ok   web-1/hello: deployed
```

Render locally and look at the files:

```
$ airstack deploy web-1 --stage
ok   web-1/airstack (machine): staged
ok   web-1/hello: staged
ok   web-1/hello-dev: staged
$ cat .airstack/deploy/web-1/hello/docker-compose.yml
```

Deploy one instance on all web machines:

```sh
airstack deploy 'web-*' --stack hello
```

## Exit codes

| Code | When |
|---|---|
| 0 | All units deployed. |
| 1 | Deployed with warnings. |
| 2 | A machine or a unit failed, or a name matched no machine. |
| 3 | A usage error (bad option, no target). |

When a unit fails, deploy prints the path of its log directory.

## What it changes

On the controller (all in the gitignored `.airstack/` of the fleet repo):

- `.airstack/deploy/<machine>/<unit>/`: the staged files.
- `.airstack/logs/<machine>/<unit>/<time>/`: deploy logs.
- `.airstack/reports/<machine>/<unit>.md`: deploy reports.
- `.airstack/secrets/<machine>.jsonc`: only `--install`, only when it generates
  `SUDO_USER_PASSWORD`.

On the machine:

- Each unit's install directory: `<root>/machine/` (machine unit), `<root>/stacks/<instance>/`
  (stack owner), `/home/<user>/airstack/<instance>/` (dev account). Owned by the run user, mode
  750. The compose file on the machine is `docker-compose.yml` (mode 600).
- Containers of each compose project.
- `/etc/cron.d/<project>_*` and `/etc/airstack/stacks/<project>.env`.
- `/etc/airstack/machine.yaml`, `/etc/airstack/redact.json`, `/etc/sudoers.d/airstack`, the group
  `airstack-admin`.
- `/usr/local/lib/airstack/versions/<version>/` and `/usr/local/bin/airstack`.
- The config history in `<root>/.stack` (a commit per deployed unit).
- `--install`: users, packages, SSH settings, firewall, Docker, a reboot.

`--stage` changes only `.airstack/` on the controller. `--dry-run` syncs files and validates, but
does not change the airstack binary, the helper files, the marker or the containers.
