# status, ssh

Two controller verbs that connect to machines over SSH. Both need a fleet. Both use the SSH
settings of the machine file (`host.ip` or `host.hostname`, `host.ssh.user`, `host.ssh.port`,
`host.ssh.key`). When `host.ssh.expose` is `tunnel`, they connect through the Cloudflare tunnel.

## status

`status` shows, for each machine, the containers of each unit (the machine unit `airstack` and
each stack instance). It also reports instances that are deployed but no longer in the machine
file.

### Usage

```
airstack status [<machine>... | '<pattern>' | --all]
```

### Options

| Option | Meaning |
|---|---|
| `<machine>...` | These machines. Patterns with `*` work (quote them). |
| `--all` | All machines (the default when you name none). |

### Output

One line per unit: `<machine>/<unit>: <service>=<state> …`.

- `ok`: all containers of the unit run.
- `warn`: at least one container does not run.
- No prefix: `no containers`.

A machine that does not answer gets a `fail` line. A machine without the marker gets a `warn` line
and `-> airstack deploy <machine> --install`.

### Examples

```
$ airstack status
ok   web-1/airstack: cloudflared=running
ok   web-1/hello: whoami=running
warn web-1/hello-dev: whoami=exited
warn web-1/old-app: deployed but not in the machine file -> airstack deploy web-1 --prune
```

```
$ airstack status web-2
fail web-2: unreachable over SSH (adminroot@192.0.2.11:222)
```

### What it changes

Nothing. It runs `docker compose ps` on each machine.

## ssh

`ssh` opens an interactive SSH session to a machine. With `-- <command>`, it runs one command and
returns.

### Usage

```
airstack ssh <machine>
airstack ssh <machine> -- <command…>
```

### Options

| Option | Meaning |
|---|---|
| `<machine>` | Machine name. Required. |
| `-- <command…>` | Run this command on the machine instead of a shell. Everything after `--` goes to the machine, also `--fleet`. |

`ssh` stops only for config errors in the SSH settings or secrets. Other config errors do not
lock you out of the machine.

### Exit code

`ssh` returns the exit code of `ssh` (or of the remote command). It does not follow the 0/1/2/3
contract. A config error returns 2. A missing machine name returns 3.

### Examples

Open a shell:

```sh
airstack ssh web-1
```

Run a node verb on the machine:

```
$ airstack ssh web-1 -- airstack machine status
machine web-1  (fleet example-fleet, root /srv/airstack)
ok   airstack: 1/1 running: cloudflared
ok   hello: 1/1 running: whoami
memory 23% of 3.8 GB
disk / 31% used, 52 GB free
history  2026-11-26T09:12:40+00:00  deploy …
```

Read container logs:

```sh
airstack ssh web-1 -- sudo docker logs --tail 100 hello-whoami
```

### What it changes

Nothing by itself. The command you run can change the machine.
