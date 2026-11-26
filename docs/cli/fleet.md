# fleet

`fleet` reads and checks the fleet repo. It also runs plugin commands for a machine and puts an
airstack version on machines. It is a controller verb. It needs a fleet.

Secrets are never printed. Where a config value comes from a secret, airstack shows `${NAME}`.

## Usage

```
airstack fleet list
airstack fleet show <machine>
airstack fleet config <machine> [<instance>]
airstack fleet check [<machine>... | '<pattern>' | --all]
airstack fleet plugin <machine> <command> [args]
airstack fleet update [<machine>... | '<pattern>' | --all]
airstack fleet install <version> <machine>...
airstack fleet --help
```

A **pattern** uses `*` (for example `'web-*'`). Put quotes around a pattern: zsh stops the whole
command, or expands the pattern, when it is not quoted.

## Terms

- **Machine file**: `machines/<name>.yaml` or `machines/<name>/machine.yaml`. One per machine.
- **Stack**: a reusable service definition in `stacks/<name>/stack.yaml`. Built-in stacks start
  with `airstack/` (for example `airstack/cliproxy`).
- **Instance**: one use of a stack on a machine. It has its own compose project, install directory
  and run user. The machine file lists instances under `stacks:`.
- **Unit**: what deploy deploys. Each machine has one machine unit (compose project `airstack`)
  and one unit per instance.

## fleet list

Lists the machines, their address, and their stack instances. `name=stack` means the instance
uses another stack. A machine with config errors gets a problem count.

| Option | Meaning |
|---|---|
| (none) | |

```
$ airstack fleet list
fleet example-fleet  (/home/alex/example-fleet)  pins airstack 0.1.0
web-1                192.0.2.10                   hello hello-dev=hello
web-2                192.0.2.11                   cliproxy=airstack/cliproxy   [1 problem(s): airstack fleet check web-2]
```

What it changes: nothing.

## fleet show

Shows the resolved summary of one machine: host, SSH, users, machine root, machine plugins, and
each instance with its run user, install directory and compose project. Then it prints the
problems of that machine.

| Argument | Meaning |
|---|---|
| `<machine>` | Machine name. Required. |

```
$ airstack fleet show web-1
machine  web-1  (machines/web-1.yaml)
host     192.0.2.10  hostname web-1  tz America/New_York
ssh      adminroot@192.0.2.10:222  (fresh box: root@:22; public)
users    sudo adminroot  stack stackroot  dev deployuser
root     /srv/airstack
plugins  airstack/cron airstack/cloudflare
stack    hello  <- hello  user stackroot (stack)  dir /srv/airstack/stacks/hello  project hello
stack    hello-dev  <- hello  user deployuser (dev)  dir /home/deployuser/airstack/hello-dev  project hello-dev
```

`(stack)` means the instance runs in the root Docker daemon as the stack owner. `(dev)` means it
runs in the rootless Docker of a dev account.

What it changes: nothing.

## fleet config

Prints the merged config, one key per line. Each key has a tag that tells where it came from.

- Without `<instance>`: the machine's `host`, `root` and machine `plugins`.
- With `<instance>`: the merged config of that instance.

Merge order, lowest to highest: defaults, then `stack.yaml`, then the machine file overlay
(`stacks.<instance>`). Maps merge key by key. Lists replace the whole list. `null` deletes an
inherited key.

| Tag | Meaning |
|---|---|
| `[default]` | A value airstack computed (run user, install directory, compose project). |
| `[stack:<file>]` | From the stack file. |
| `[machine:<file>]` | From the machine file. |

| Argument | Meaning |
|---|---|
| `<machine>` | Machine name. Required. |
| `<instance>` | Instance name. Optional. |

```
$ airstack fleet config web-1 hello
# web-1/hello <- hello  (secrets shown as ${NAME})
values.port = 8080   [machine:machines/web-1.yaml]
values.tunnel = true   [machine:machines/web-1.yaml]
templates["compose.yaml"].src = compose.yaml.hbs   [stack:stacks/hello/stack.yaml]
deploy.sync.default = delete   [stack:stacks/hello/stack.yaml]
user = stackroot   [default]
installDir = /srv/airstack/stacks/hello   [default]
composeProject = hello   [default]
```

What it changes: nothing.

## fleet check

Checks the fleet offline. It connects to no machine. With no machine names, it checks all
machines.

It checks:

- `airstack.yaml` exists and parses. A missing `fleet.name` is a warning.
- Machine names, file names and the `machine:` key. A machine defined twice. `.yml` files.
- References: `stack:` and plugin names. A bare name resolves only in the fleet repo. A built-in
  needs `airstack/`. Versioned (`@`) and other `publisher/name` references are not supported yet.
- Missing secrets: every `${NAME}` without a default must be in the secrets files.
- Plugin scopes: a machine-level plugin in a stack, or a stack-level plugin on a machine.
- `host_` crons in a stack (they are allowed on the machine only).
- Run users: an instance user must be `host.users.stack` or in `host.users.dev`.
- Install directories: absolute; a dev-user stack outside the machine root; no two instances in
  the same or nested directory.
- Compose projects: unique per machine; `airstack` is the machine project.
- Host ports: two services that publish the same host port.
- Rootless Docker: no shared `airstack` network, no host port below 1024, no host networking.
- Tailscale `ports` and `serve` entries that no stack publishes (warning).
- Unknown keys (warning).

| Option | Meaning |
|---|---|
| `<machine>...` | Check these machines. Patterns work. |
| `--all` | Check all machines (the default). |

```
$ airstack fleet check
ok   web-1: 2 stack instance(s), 2 machine plugin(s)
```

```
$ airstack fleet check web-1
fail .airstack/secrets/web-1.jsonc CLOUDFLARE_TUNNEL_TOKEN: missing secret (referenced in machines/web-1.yaml, no default)
$ echo $?
2
```

What it changes: nothing.

## fleet plugin

Runs a plugin command for one machine. airstack loads the plugins of all units of the machine
and runs the first command with that name.

| Argument | Meaning |
|---|---|
| `<machine>` | Machine name. Required. |
| `<command>` | Plugin command. Required. |
| `[args]` | Passed to the command. |

Built-in plugin commands:

| Command | Plugin | Subcommands |
|---|---|---|
| `cf-tunnel` | `airstack/cloudflare` | `verify`, `verify-api-token`, `list-tunnels`, `create-tunnel <name>` |
| `tailscale` | `airstack/tailscale` | `status`, `apply` |
| `backup` | `airstack/backup` | see `backup --help` |

When the command does not exist, airstack lists the commands of that machine and exits 3. When the
machine has config errors, it exits 2 and runs nothing.

```
$ airstack fleet plugin web-1 cf-tunnel verify
```

What it changes: depends on the command. `verify` and `status` read. `create-tunnel` creates a
tunnel in your Cloudflare account and saves its token as `CLOUDFLARE_TUNNEL_TOKEN` in
`.airstack/secrets/<machine>.jsonc` (it never prints the token). `tailscale apply` changes firewall rules on the machine.

## fleet update

Puts the pinned airstack version on machines. The pin is `airstack.version` in `airstack.yaml`.
Without a pin, it is the version of this controller. With no machine names, it updates all
machines.

| Option | Meaning |
|---|---|
| `<machine>...` | Update these machines. Patterns work. |
| `--all` | All machines (the default). |

A machine without `/etc/airstack/machine.yaml` fails with `-> airstack deploy <machine> --install`.

```
$ airstack fleet update
->   web-1: download https://github.com/airstack/airstack/releases/download/v0.1.0/airstack-0.1.0-linux-x64.tar.gz
ok   web-1: airstack installed 0.1.0
```

What it changes: on each machine, `/usr/local/lib/airstack/versions/<version>/` and the symlink
`/usr/local/bin/airstack`. Stacks keep running. See [versions.md](versions.md).

## fleet install

Puts one given airstack version on machines.

| Argument | Meaning |
|---|---|
| `<version>` | A version like `0.1.0`. Required. |
| `<machine>...` | One or more machines or patterns. Required. |

When `airstack.yaml` pins another version, airstack warns: the next deploy or `fleet update` puts
the pinned version back.

```
$ airstack fleet install 0.1.1 web-1
warn airstack.yaml pins 0.1.0: the next deploy or fleet update puts 0.1.0 back
ok   web-1: airstack installed 0.1.1
```

What it changes: the same as `fleet update`.

## Container logs

There is no `fleet logs` verb. Use one of these:

```sh
airstack ssh web-1 -- airstack machine logs hello
airstack ssh web-1 -- sudo docker logs --tail 100 hello-whoami
```
