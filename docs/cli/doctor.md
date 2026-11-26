# doctor

`doctor` checks this machine. It runs in both modes. On a controller, it can also run `doctor` on
nodes. `--fix` makes small, safe fixes only.

`airstack update` and `airstack install <version>` run `doctor` at the end.

## Usage

```
airstack doctor [--fix]
airstack doctor [--fix] <machine>... | '<pattern>' | --all     (controller, in a fleet)
```

## Options

| Option | Meaning |
|---|---|
| `--fix` | Make the safe fixes listed below. |
| `<machine>...` | Controller only: also run `doctor` on these nodes over SSH. Patterns work (quote them). |
| `--all` | Controller only: also run `doctor` on all nodes. |

## Checks on a controller

| Check | Result |
|---|---|
| `ssh`, `rsync`, `git`, `tar` are installed. | `fail` when one is missing. |
| `~/.local/bin` is on `PATH`. | `warn` when not (the installer puts airstack there). |

With a fleet (`./airstack.yaml`, `--fleet`, or the user config):

| Check | Result | `--fix` |
|---|---|---|
| The `airstack.yaml` version pin is this airstack's version. | `warn` and `-> airstack install <pin>` | no |
| `.airstack/` is gitignored (only in a git repo). | `fail` | Adds `.airstack/` to `.gitignore`. |
| Files `.airstack/secrets/*.jsonc` have mode 600. | `warn` | `chmod 600` |
| No secret value (8 characters or more) is in a committed file. | `fail` (names the file and the secret name, never the value) | no |
| All machine files load without errors. | `fail` and `-> airstack fleet check` | no |

## Checks on a node

On a node, `doctor` runs itself again through `sudo -n` when you are not root. Members of
`airstack-admin` may do that without a password. If sudo refuses, doctor warns and skips the
checks that need root.

| Check | Result | `--fix` |
|---|---|---|
| The marker `/etc/airstack/machine.yaml` exists and is trusted. | `fail` | no |
| `/usr/local/bin/airstack` exists and points into `/usr/local/lib/airstack/versions/`, owned by root. | `fail` / `warn` | no |
| The version in the marker matches the running airstack. | `warn` | no |
| The config history `<root>/.stack` is root-owned, mode 700. | `fail` | `chmod 700` |
| Each unit has a managed file list. | `warn` | no |
| `/etc/airstack/redact.json` exists, root-owned, mode 600. | `warn` / `fail` | `chmod 600` |
| `/etc/sudoers.d/airstack` exists. | info line | no |
| Docker answers (`docker info`). | `fail` | no |

## Examples

On a controller, in a fleet:

```
$ airstack doctor
ok   ssh found
ok   rsync found
ok   git found
ok   tar found
fleet example-fleet  (/home/alex/example-fleet)
ok   version pin 0.1.0 matches
ok   .airstack/ is gitignored
warn secrets files readable by others: _fleet.jsonc
->   airstack doctor --fix
ok   no secret values in 6 committed file(s)
ok   1 machine file(s) load without errors (airstack fleet check runs the full check)
$ airstack doctor --fix
…
ok   fixed: chmod 600 _fleet.jsonc
```

Check the controller and one node:

```
$ airstack doctor web-1
ok   ssh found
…

web-1:
  ok   marker /etc/airstack/machine.yaml (machine web-1)
  ok   airstack 0.1.0 (active)
  ok   config history /srv/airstack/.stack (root only)
  ok   /etc/airstack/redact.json (root only)
  ok   docker 28.5.1
```

## Exit codes

0 when all checks pass, 1 with warnings, 2 with failures. On a controller, the exit code of each
node's `doctor` counts too.

## What it changes

Without `--fix`: nothing.

With `--fix`, only these:

- Controller: `.gitignore` (adds `.airstack/`), the mode of `.airstack/secrets/*.jsonc` (600).
- Node: the mode of `<root>/.stack` (700) and of `/etc/airstack/redact.json` (600).

With `<machine>` or `--all`, `--fix` also runs on those nodes.
