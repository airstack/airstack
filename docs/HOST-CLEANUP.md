# Host cleanup and disk alerts

Two cron scripts (cron plugin, `cli/plugins/cron/deploy/host-status/`):

- `host_cleanup.sh` frees disk, inodes and `/tmp`. Runs as root.
- `host_alerter.sh` (existing) now also alerts on free space and inodes.

The daily report's Security section (`host_security.sh`) is in [HOST-SECURITY.md](HOST-SECURITY.md).

Configure both through each cron's `env:` in `stack.yml`. Env values are kept in
`crons/env.d/<cron>.env` (root, mode 600), never in `/etc/cron.d`.

## What the cleanup does

| Run | What |
|---|---|
| Daily (`host_cleanup`, 4 AM) | Prune unused Docker **images** and **build cache** older than 7 days on every daemon in `CLEANUP_DOCKER_HOSTS`; `apt-get clean`; `journalctl --vacuum-size=500M`; delete cache files unused for 14+ days under `~/.npm/_cacache`, `~/.cache/uv`, `~/.cache/pip`, `~/.cache/pre-commit`; run the `/tmp` guard |
| Every 10 min (`host_cleanup_tmp`) | The `/tmp` guard only (a couple of `df` calls when all is well) |

It **never** touches Docker volumes, containers (stopped ones too), git worktrees
(t3 cleans those), project folders, `~/.claude` or `~/.codex`. An image is only
pruned if no container (running or stopped) uses it.

Try it safely: `host_cleanup.sh --dry-run` logs what it would delete and deletes nothing.
Log: `/home/deploy/logs/host_cleanup.log`.

## The /tmp guard

Off unless `TMP_PRUNE=true`. When free **inodes or space** on the filesystem holding a
`TMP_DIRS` entry drops below its trigger, it:

1. Deletes everything older than `TMP_MAX_AGE_DAYS` (7).
2. If still below `TMP_TARGET_FREE_PCT` (50), deletes the oldest files first, `TMP_BATCH`
   (100) at a time, until both numbers reach the target.
3. Removes empty directories.

Never deleted, even to reach the target: anything newer than `TMP_MIN_AGE_MINUTES` (60),
sockets, and the names in `TMP_EXCLUDE` (`systemd-private-*`, `.X11-unix`, `ssh-*`, `tmux-*`, `*.sock`, ...).
It stays on one filesystem (`find -xdev`) and refuses `/`.

| Knob | Default | Meaning |
|---|---|---|
| `TMP_PRUNE` | `false` | turn the guard on |
| `TMP_DIRS` | `/tmp` | space-separated dirs |
| `TMP_TRIGGER_INODE_FREE_PCT` | 20 | start below this % free inodes |
| `TMP_TRIGGER_SPACE_FREE_PCT` | 20 | start below this % free space |
| `TMP_TARGET_FREE_PCT` | 50 | stop when both are at least this % free (must be >= both triggers) |
| `TMP_MAX_AGE_DAYS` | 7 | phase 1 age |
| `TMP_MIN_AGE_MINUTES` | 60 | safety floor |
| `TMP_EXCLUDE` | see script | top-level names to skip |
| `TMP_BATCH` | 100 | files per free-space check in phase 2 |

Other knobs (`CLEANUP_DOCKER`, `CLEANUP_DOCKER_HOSTS`, `CLEANUP_DOCKER_UNTIL`, `CLEANUP_APT`,
`CLEANUP_JOURNAL_MAX`, `CLEANUP_CACHE_DIRS`, `CLEANUP_CACHE_MAX_AGE_DAYS`) are listed at the top of the script.
Add a rootless daemon with `CLEANUP_DOCKER_HOSTS="unix:///var/run/docker.sock unix:///run/user/1002/docker.sock"`.

On some VPS images `/tmp` is a **tmpfs** (RAM): its space is memory, and it has a fixed inode cap
(`nr_inodes`), so inodes run out first when tests write many small files.

## Alerts (host_alerter)

| Env | Default | Alert when |
|---|---|---|
| `DISK_FREE_MIN_GB` | 0 (off) | free space on `/` is below this many GB |
| `INODE_FREE_MIN_PCT` | 10 | free inodes on a watched mount are below this % |
| `ALERT_MOUNTS` | `/ /tmp` | mounts watched (deduplicated by mount point) |
| `DISK_THRESHOLD` | 85 | space used on a non-root watched mount is above this % |

Alerts use a 5 GB / 5 % bucket in their text, so a slowly shrinking number does not re-alert
on every run (alerts fire when the text changes). The daily report and `health.json` carry exact values.
The cleanup triggers (20%) sit above the alert threshold (10%): an inode alert means pruning is not keeping up.
