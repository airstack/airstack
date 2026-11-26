# machine

`machine` acts on this node only. It shows status, runs checks, shows logs, reads the config
history and repairs units. It is a node verb: it runs only where `/etc/airstack/machine.yaml`
exists.

From a controller, run it over SSH:

```sh
airstack ssh web-1 -- airstack machine status
```

## Usage

```
airstack machine <command> [args]
airstack machine --help
```

## Units

Most commands take a **unit**. A unit is one compose project on this machine:

| Unit name | What |
|---|---|
| `machine` (or `airstack`) | The machine unit in `<root>/machine/` (compose project `airstack`: cloudflared, host crons). |
| `<instance>` | A stack instance, for example `hello`. Its install directory and run user come from the marker. |

A wrong unit name prints the list of units on this machine.

## Root, sudo and the airstack-admin group

The machine commands read root-only files (`<root>`, `<root>/.stack`, `/etc/airstack`). When you
are not root, airstack runs the same command again through `sudo -n` (sudo without a password
prompt).

- A sudo user with a cached password, or with `NOPASSWD`, can run all commands.
- Members of the group `airstack-admin` can run `/usr/local/bin/airstack machine *` and
  `/usr/local/bin/airstack doctor` as root
  without a password and without full sudo. Deploy writes this rule to `/etc/sudoers.d/airstack`.
  Deploy adds the users in `host.users.admins` (machine file) to the group.
- Anybody else gets: `machine <command> needs root: run it with sudo, or join the airstack-admin group`
  (exit 3).

This is a convenience. sudo decides who may run the commands. The airstack check is not a
security boundary.

## Read commands

These commands change nothing (except: `config diff` saves box edits in the history first).

| Command | What it does |
|---|---|
| `status` | Containers per unit, memory, disk, and the last history entry. |
| `check [-v]` | Security and health checks as `ok` / `warn` / `fail` lines. `-v` also lists the checks that passed. |
| `report [--full]` | The daily host report as text. Short: problems and one summary line. `--full`: every check and the details. |
| `logs <unit> [<service>] [-n N] [-f]` | `docker compose logs` of the unit. `-n`: number of lines (default 100). `-f`, `--follow`: keep following. |
| `config read <unit>` | Lists the managed files of the unit (tracked and rendered). |
| `config read <unit> <file>` | Shows one managed file, secrets redacted, with line numbers. |
| `config diff [<unit>] [--since <rev>]` | Box edits since the last deploy (or since `<rev>`), redacted. Without a unit: all units. |
| `history [<unit>] [-n N]` | The config history: deploys, box edits, rollbacks. `-n`: number of entries (default 20). |

Notes:

- `check` uses the checks of the daily report when the machine has the `host_alerter_report`
  cron. Without that cron, it checks the containers and runs `host_security.sh`.
- `report` needs the `host_alerter_report` cron. It exits 1 when the report says that issues need
  attention.

## Repair commands

These commands change the machine.

| Command | What it does |
|---|---|
| `snapshot [<unit>]` | Saves box edits in the config history now. Without a unit: all units. |
| `apply <unit>` | Saves box edits, then runs `docker compose up -d --remove-orphans`. Use it after you edit a managed file on the machine. |
| `restart <unit> [<service>]` | `docker compose restart` (all services, or one). |
| `rollback <unit> [<rev>]` | Restores the managed files of the unit from a history commit, then runs `docker compose up -d`. Default `<rev>`: the last deploy. |

`rollback` saves the live files first (`box edit (before rollback)`), so you can undo the
rollback. Then it commits `rollback to <rev>`.

`apply` prints `-> airstack pull <machine>` after it saved edits: bring the edits into the fleet
repo, or the next deploy refuses to overwrite them (see [deploy.md](deploy.md#drift-guard-and---force)).

## Config history

### File modes

airstack sorts the files of each unit into three modes:

| Mode | What | Deploy | History |
|---|---|---|---|
| **rendered** | Every file that deploy ships (compose file, cron files, scripts). | Overwrites it. An edit on the machine is **drift**. | Yes |
| **tracked** | Config that the machine owns and a plugin names, for example `.cliproxyapi/config.yaml` of `airstack/cliproxy`. | Never writes it. | Yes |
| **state** | Everything else: auth files, data, logs. | Never writes it (unless the stack's sync rules delete it). | No |

Deploy writes the list of rendered and tracked files to `.stack-config/managed.json` in each
unit. The node reads that list. It does not need the fleet repo.

### The .stack store

The config history is a git repo at `<root>/.stack` (default `/srv/airstack/.stack`). It is owned
by root, mode 700, because it holds the exact live files, secrets included.

```
<root>/.stack/
  machine/…            managed files of the machine unit
  stacks/<instance>/…  managed files of each stack instance
```

| Ref | Meaning |
|---|---|
| `main` | Every commit: `first snapshot: …`, `box edit: …`, `deploy <unit> (fleet <commit>): …`, `rollback to …`. |
| `refs/airstack/deployed/<slot>` | The commit of the last deploy of a unit (`machine` or `stacks/<instance>`). |

Commits are made by:

- `deploy`: one commit per unit after sync (and a `box edit (found before deploy)` commit when the
  drift guard finds edits).
- `machine snapshot`, `apply`, `config diff`, `rollback`.
- `airstack pull` (it runs `machine snapshot`).

`<rev>` in `rollback` and `config diff --since` is any git revision of this store, for example a
short commit id from `machine history`.

### Rollback

1. Find the commit: `airstack machine history hello`.
2. Restore it: `airstack machine rollback hello 3f2a9c1d`.
3. Check: `airstack machine status`.

Without `<rev>`, rollback goes back to the last deploy. This drops box edits (they stay in the
history).

## Examples

```
$ airstack machine status
machine web-1  (fleet example-fleet, root /srv/airstack)
ok   airstack: 1/1 running: cloudflared
ok   hello: 1/1 running: whoami
fail hello-dev: 0/1 running: whoami (exited)
memory 23% of 3.8 GB
disk / 31% used, 52 GB free
history  2026-11-26T09:12:40+00:00  deploy hello (fleet 4c1d2e9): docker-compose.yml
```

```
$ airstack machine config diff
warn hello: box edits since the last deploy (0 value(s) redacted)
diff --git a/stacks/hello/docker-compose.yml b/stacks/hello/docker-compose.yml
…
-      - "127.0.0.1:8080:8080"
+      - "127.0.0.1:8090:8080"
```

```
$ airstack machine history hello -n 3
8b41e07a  2026-11-26 10:02:11  box edit: hello: docker-compose.yml
3f2a9c1d  2026-11-26 09:12:40  deploy hello (fleet 4c1d2e9): docker-compose.yml
1a7c0b55  2026-11-25 18:40:03  first snapshot: hello: docker-compose.yml
$ airstack machine rollback hello
ok   hello: restored 1 file(s) from 3f2a9c1d: docker-compose.yml
     history: 9e0f1a2b
ok   hello: containers updated
```

## Internal commands

Deploy calls two more commands over SSH. They print one JSON line. Do not use them by hand.

- `machine drift <unit> [--base <rev>]`: the drift guard.
- `machine record-deploy <unit> [--commit <fleet commit>]`: records a deploy.

## What it changes

- Read commands: nothing on disk, except `config diff` (it can commit box edits to the history).
- `snapshot`: a commit in `<root>/.stack`.
- `apply`: a commit, and containers of the unit.
- `restart`: containers of the unit.
- `rollback`: the unit's managed files, commits in `<root>/.stack`, containers of the unit.
