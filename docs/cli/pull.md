# pull

`pull` copies the live managed files of one machine to the controller. Then it shows how they
differ from the fleet repo, with secrets redacted. It is a controller verb. It needs a fleet.

Use it when someone changed a deployed file directly on the machine (a **box edit**), and you
want to keep that change.

## Usage

```
airstack pull <machine>
airstack pull --help
```

## Options

| Argument | Meaning |
|---|---|
| `<machine>` | Machine name. Required. |
| `-h`, `--help` | Print the usage. |

## Terms

- **Managed file**: a file that airstack knows on the machine. It is **rendered** (deploy writes
  it) or **tracked** (the machine owns it, for example cliproxy's `.cliproxyapi/config.yaml`).
  See [machine.md](machine.md#config-history).
- **Redacted**: secret values are replaced by short markers. A redacted diff never shows a secret.

## What pull does

1. On the machine, it saves the box edits in the config history (`airstack machine snapshot`).
2. It copies the history work tree (`<root>/.stack/`) to `.airstack/pull/<machine>/`. These are
   the raw files, secrets included.
3. It writes the history commit it saw to `.airstack/deploy/<machine>/.stack-base`. From now on,
   deploy may overwrite those box edits: you have seen them.
4. It renders the fleet locally (like `deploy --stage`) and compares each unit:
   - **Rendered files**: a redacted diff from the fleet render to the machine.
   - **Tracked files**: a redacted diff of what changed since the last pull. The first pull
     prints `box-owned <file> (first pull)`.

Then:

1. Read the diff.
2. Put the edits you want to keep into the fleet repo (templates or values).
3. Run `airstack deploy <machine>`.

## Examples

No box edits:

```
$ airstack pull web-1
ok   web-1: pulled history 3f2a9c1d into .airstack/pull/web-1
ok   machine: rendered files match the fleet
ok   hello: rendered files match the fleet
```

A box edit in a rendered file:

```
$ airstack pull web-1
     hello: saved box edits in 8b41e07a: docker-compose.yml
ok   web-1: pulled history 8b41e07a into .airstack/pull/web-1
ok   machine: rendered files match the fleet
warn hello: 1 file(s) on the machine differ from the fleet: docker-compose.yml
diff --git fleet/docker-compose.yml machine/docker-compose.yml
--- fleet/docker-compose.yml
+++ machine/docker-compose.yml
@@ -7,4 +7,4 @@
     command: ["--port", "8080", "--name", "hello"]
     ports:
-      - "127.0.0.1:8080:8080"
+      - "127.0.0.1:8090:8080"
```

## Errors

| Message | Cause | Fix |
|---|---|---|
| `snapshot failed` | The machine has no airstack with config history. | Run `airstack deploy <machine>`. |
| `config errors` | The machine file has errors. | Run `airstack fleet check <machine>`. |
| `copy from … failed` | `rsync` failed. | Check SSH with `airstack ssh <machine>`. |

## What it changes

On the controller (gitignored):

- `.airstack/pull/<machine>/`: the live managed files (mode 700 directory). The previous pull is
  kept while pull runs and then removed.
- `.airstack/deploy/<machine>/.stack-base`: the history commit you saw.
- `.airstack/deploy/<machine>/<unit>/` and `.airstack/logs/`: the local render.

On the machine:

- A new commit in the config history (`<root>/.stack`) when there were box edits.
- No deployed file changes. No container changes.
