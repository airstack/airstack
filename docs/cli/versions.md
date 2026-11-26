# versions, update, install

Three verbs for airstack itself on **this** machine. They run in both modes. To change the airstack
version on other machines, use `airstack fleet update` or `airstack fleet install` (see
[fleet.md](fleet.md)).

## Usage

```
airstack versions
airstack update
airstack install <version>
```

## versions

Lists the airstack versions installed on this machine. `*` marks the active version.

| Option | Meaning |
|---|---|
| (none) | |

```
$ airstack versions
running  airstack 0.1.0
* 0.1.0
  0.0.9
```

What it changes: nothing.

## update

Installs the newest published airstack release. airstack reads the newest release from GitHub
(`airstack/airstack`). When this airstack is a release and is already the newest, it stops with
`ok`.

```
$ airstack update
->   download https://github.com/airstack/airstack/releases/download/v0.1.1/airstack-0.1.1-darwin-arm64.tar.gz
ok   airstack 0.1.1 in /home/alex/.local/lib/airstack/versions/0.1.1; ~/.local/bin/airstack now points to it
->   airstack doctor
```

Then `update` runs `airstack doctor`.

## install

Installs one given release. `<version>` looks like `0.1.0`.

| Argument | Meaning |
|---|---|
| `<version>` | The version to install. Required. |

```
$ airstack install 0.1.0
ok   airstack 0.1.0 in /home/alex/.local/lib/airstack/versions/0.1.0; ~/.local/bin/airstack now points to it
```

Then `install` runs `airstack doctor`.

## Where airstack gets a release

On a controller, airstack looks in this order:

1. A source checkout of the same version: airstack builds the release from it. The build is
   cached; an unchanged checkout builds once.
2. The release cache: `~/.cache/airstack/releases/<version>/` (or `$XDG_CACHE_HOME/airstack/…`).
3. The GitHub release `v<version>`. airstack checks the file against `SHA256SUMS`.

## Release layout

A release is one file per target: `airstack-<version>-<os>-<arch>.tar.gz`. Targets: `linux-x64`,
`linux-arm64`, `darwin-arm64`, `darwin-x64`. The file holds `bin/airstack` (one compiled binary)
and the core files next to it: built-in plugins, templates, stacks and setup scripts.

On a controller (user-local, never global):

```
~/.local/lib/airstack/versions/<version>/   one directory per installed release
~/.local/bin/airstack                        symlink to the active release's bin/airstack
```

On a node (owned by root, mode 755):

```
/usr/local/lib/airstack/versions/<name>/    one directory per installed build
/usr/local/bin/airstack                     symlink to the active build's bin/airstack
```

`<name>` is `0.1.0` for a release and `0.1.0-<build>` for a development build. A node keeps the
last few builds. The same build is never sent twice.

## Node policy

A node gets airstack from its controller. The binary runs as root, so its source is the
controller unless the owner says otherwise.

- Deploy, `airstack fleet update` and `airstack fleet install` put airstack on nodes. The wanted
  version is `airstack.version` in `airstack.yaml`, else the controller's version.
- On a node, `update` and `install` are refused by default:

  ```
  fail blocked: this node gets airstack from its controller
  ->   airstack fleet update <machine>   (on the controller)
  ```

- The marker key `update: { allowSourceUpdate: true }` in `/etc/airstack/machine.yaml` allows them.
  Then they must run as root (`sudo airstack update`), and download the release (never a source
  build).
- Deploy keeps this key when it rewrites the marker.

## What it changes

- `versions`: nothing.
- `update` / `install` on a controller: `~/.local/lib/airstack/versions/<version>/`,
  `~/.local/bin/airstack`, the release cache. If `~/.local/bin` is not on `PATH`, airstack warns
  and prints the line to add.
- `update` / `install` on a node (when allowed): `/usr/local/lib/airstack/versions/<name>/` and
  `/usr/local/bin/airstack`.
