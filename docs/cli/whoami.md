# whoami, version, help

Three read-only verbs. They run in both modes (controller and node). They need no fleet.

## whoami

`whoami` shows how airstack sees this machine:

- the mode (controller or node) and the roles,
- the machine name (node) and the path of the marker,
- the fleet path, and how airstack found it,
- the user, the airstack version and the user config file,
- the verbs that are on, and why each other verb is off.

Use it first when a verb is blocked.

### Usage

```
airstack whoami
```

### Options

None. The global `--fleet <path>` changes the fleet that `whoami` reports.

### Output fields

| Field | Meaning |
|---|---|
| `mode` | `controller` or `node`. |
| `roles` | `controller`, or `node` (and `controller` when the marker allows it). |
| `machine` | The machine name and the marker path. `-` on a controller. |
| `fleet` | The fleet path and its source: `flag` (`--fleet`), `cwd` (`./airstack.yaml`), `config` (`~/.config/airstack/config.yaml`) or `pinned` (the marker). `-` when there is no fleet. |
| `user` | The user name and uid. |
| `version` | The airstack version. `(source)` means a run from a source checkout. |
| `config` | The user config file. Shown only when it exists. |
| `verbs on` | The verbs that can run here. |
| `off` | One line per blocked verb, with the reason. |

`whoami` adds a `warn` line when the marker is not trusted (wrong owner or mode), and when a node
ignores `./airstack.yaml`.

### Examples

On a controller, in a fleet repo:

```
$ airstack whoami
mode     controller
roles    controller
machine  - (no /etc/airstack/machine.yaml: this is a controller)
fleet    /home/alex/example-fleet  (cwd)
user     alex (uid 1000)
version  airstack 0.1.0
verbs on whoami version help doctor versions update install init fleet deploy status ssh pull
off      machine: node only (no /etc/airstack/machine.yaml)
```

On a node:

```
$ airstack whoami
mode     node
roles    node
machine  web-1  (/etc/airstack/machine.yaml)
fleet    -
user     adminroot (uid 1000)
version  airstack 0.1.0
verbs on whoami version help doctor versions update install machine
off      init: needs controller role (roles: [node])
off      fleet: needs controller role (roles: [node])
…
```

### What it changes

Nothing.

## version

`version` prints the airstack version.

```
airstack version
airstack --version
airstack -v
```

```
$ airstack version
airstack 0.1.0
```

A source run prints `0.1.0 (source)`. A development build prints `0.1.0 (build <id>)`.

What it changes: nothing.

## help

`help` prints the usage line and one line per verb. A verb that is off on this machine gets the
note `[off here: airstack whoami]`.

```
airstack help
airstack --help
airstack -h
airstack
```

`help` takes no verb argument. For the options of one verb, use `airstack <verb> --help`
(`fleet`, `deploy`, `pull`, `machine` and `init` support it).

What it changes: nothing.
