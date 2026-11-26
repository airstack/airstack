# init

`init` creates a new fleet repo skeleton. It is a controller verb. It needs no existing fleet.

The files come from templates inside the airstack binary. The airstack version in
`airstack.yaml` is the version of the airstack that runs `init`.

## Usage

```
airstack init [<dir>]
```

`<dir>` is the directory for the new fleet. The default is the current directory. `init` creates
the directory when it does not exist.

## Options

| Option | Meaning |
|---|---|
| `<dir>` | Directory for the new fleet (default `.`). |
| `-h`, `--help` | Print the usage. |

The global `--fleet` has no effect on `init`.

## What it creates

| Path | Content | Mode |
|---|---|---|
| `airstack.yaml` | Version pin (this airstack's version) and `fleet.name` (the directory name). | 644 |
| `.gitignore` | `.airstack/` | 644 |
| `machines/web-1.yaml.example` | A commented example machine. airstack ignores it until you copy it to a `.yaml` name. | 644 |
| `stacks/README.md` | How stacks work. | 644 |
| `plugins/README.md` | How fleet plugins work. | 644 |
| `templates/README.md` | How template overrides work. | 644 |
| `.airstack/secrets/_fleet.jsonc` | `{}` with comments. | 600 |

`.airstack/` and `.airstack/secrets/` get mode 700.

## Safety rules

- When `<dir>/airstack.yaml` exists, `init` refuses with exit code 3. It changes nothing.
- `init` never overwrites a file. It keeps an existing file and prints a `warn` line for it
  (exit code 1).
- An existing `.gitignore` is kept. When it does not ignore `.airstack/`, `init` adds the line
  `.airstack/` at the end.
- `init` writes `airstack.yaml` last. If `init` fails part way, you can run it again.

## Next steps

`init` prints the next steps as `->` lines:

1. `cd <dir>` (only when `<dir>` is not the current directory).
2. `git init` (only when `<dir>` is not in a git repo).
3. Copy the example machine and edit it: `cp machines/web-1.yaml.example machines/web-1.yaml`.
4. `airstack fleet check`.
5. `airstack deploy web-1 --install`.

## Examples

Create a fleet in a new directory:

```
$ airstack init example-fleet
ok   created example-fleet/.gitignore
ok   created example-fleet/machines/web-1.yaml.example
ok   created example-fleet/stacks/README.md
ok   created example-fleet/plugins/README.md
ok   created example-fleet/templates/README.md
ok   created example-fleet/.airstack/secrets/_fleet.jsonc (mode 600)
ok   created example-fleet/airstack.yaml
fleet example-fleet pins airstack 0.1.0
->   cd example-fleet
->   git init
->   cp machines/web-1.yaml.example machines/web-1.yaml   (then edit host.ip, host.ssh, host.users)
->   airstack fleet check
->   airstack deploy web-1 --install   (first-time setup of a fresh box)
```

Run it again:

```
$ airstack init example-fleet
fail blocked: example-fleet/airstack.yaml already exists; init never overwrites a fleet
->   airstack --fleet example-fleet fleet check
$ echo $?
3
```

## What it changes

Only files and directories in `<dir>`. It touches no machine and no user config.

## See also

- [../../examples/fleet/](../../examples/fleet/): a complete example fleet with a stack.
- [fleet.md](fleet.md): `fleet check`.
- [deploy.md](deploy.md): `deploy --install`.
