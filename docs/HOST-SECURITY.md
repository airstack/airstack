# Host security checks

`host_security.sh` (cron plugin, `cli/plugins/cron/deploy/host-status/`) adds a **Security**
section to the daily Telegram report. It runs a set of read-only checks as root and prints
one line per finding.

It is a **daily tripwire, not an intrusion detection system (IDS)**. It notices drift and
plain misconfiguration: a port that opened by mistake, a Docker setting that defeats the
firewall, a new SSH key, a new process that talks to the internet. A careful attacker who
already has root can hide from it. See [Limits](#limits-what-it-does-not-detect).

Related: [HOST-CLEANUP.md](HOST-CLEANUP.md) (disk alerts and cleanup, same cron plugin).

## How it runs

| Run | What |
|---|---|
| Daily report (`host_alerter_report`, `host_alerter.sh --report`) | Calls `host_security.sh --telegram` and appends the section. Each WARN or FAIL adds 1 to the report's "issue(s) need attention" count. |
| Every 15 min (`host_alerter`) | Calls `host_security.sh --sample` after its own work. This records outbound connections (see [Outbound tracking](#outbound-tracking)). It never changes the alerter's alerts or exit status. |

You do not need a new cron entry. The script ships with the cron plugin. The alerter
finds it at `{installDir}/plugins/cron/host-status/host_security.sh`.

Run it by hand on the VPS:

```bash
sudo env INSTALL_DIR=/home/deploy STATE_DIR=/home/deploy/.stack-state \
  /home/deploy/plugins/cron/host-status/host_security.sh            # raw lines
sudo ... host_security.sh --telegram                                 # the Telegram section
sudo ... host_security.sh --help                                     # usage and all knobs
```

A by-hand run updates the baselines (see below). Use `SECURITY_STATE_DIR=/tmp/x` to try it without touching them.
`--telegram` also appends the raw lines to `{installDir}/logs/host_security.log`.

## Output protocol

Every check prints lines like this:

```text
STATUS|label|detail
```

- `STATUS` is `OK`, `WARN`, `FAIL` or `INFO`.
- A `|` inside the label or the detail becomes `/`.
- One finding per line.
- A label that starts with `reachable:` goes into the "Reachable from the internet" block.

## Reading the Telegram section

```text
<b>Security:</b>
🔴 tailscale:netfilter: tailscale default netfilter mode: ...   FAIL lines first
⚠️ persistence: since last run: added: unit:foo.service          then WARN lines
Reachable from the internet:
🌐 ssh: tcp/222 open to the internet; key-only, root login off, AllowUsers: adminroot
🌐 public: also open (expected): udp/41641
🌐 listeners: on all interfaces, UFW blocks public: tcp/8317, tcp/20241
🌐 tailnet: not public: UFW on tailscale0 tcp/3773, tcp/8317; serve tcp/3773 → 127.0.0.1:3773
🌐 tunnel: cliproxy.example.com → http://localhost:8317 (4 connections)
✅ 12 checks OK                                                  all OK lines, collapsed
ℹ️ ssh:logins: 24 h: adminroot from 203.0.113.7 (public) 08:02–09:31, key "laptop"   a few INFO lines
… +3 more (see logs/host_security.log)
```

- 🔴 = FAIL, ⚠️ = WARN, ℹ️ = INFO, 🌐 = INFO in the reachability block.
- The section has at most 25 lines and at most 8 INFO lines. A detail longer than 160 characters is cut.
- Telegram allows 4096 characters per message. When the report is too long, INFO lines go
  first. The reachability block and the WARN/FAIL lines stay.
- If the script crashes or takes longer than 60 s, the report says
  `⚠️ Security checks failed to run` and counts 1 issue. The report is always sent.

## The checks

Each check is one function. A check skips itself when its tool is missing. A check that
cannot read something (no root, no permission) prints `INFO ... could not check`, never an error.
Disable a check with `SECURITY_SKIP="name ..."`.

| Name | What it checks | Result |
|---|---|---|
| `firewall` | `ufw status verbose`: active, default incoming deny. `iptables -S INPUT`: policy DROP or ufw chains hooked in. | FAIL if ufw is off or allows incoming by default. WARN if ufw chains are not hooked. |
| `tailscale` | If `tailscale` and `tailscale0` exist: `iptables -C INPUT -j ts-input` (and ip6tables). If that rule exists, tailscale is in its default netfilter mode and all tailnet traffic skips UFW. Also `BackendState` and this node's tags. | FAIL on divert ("run `tailscale set --netfilter-mode=nodivert`"). WARN if not Running. |
| `reachability` | Builds the "Reachable from the internet" block. Public ports = UFW allow rows without `on <iface>`, from Anywhere (v4/v6 merged). It compares them to `SECURITY_PUBLIC_PORTS`. It lists TCP sockets on all interfaces (`ss -tlnH`), ignoring loopback, tailnet addresses (`100.64.0.0/10`, `fd7a:`, `%tailscale0`) and private addresses. It lists UFW rules on `tailscale0` and `tailscale serve` TCP forwards as **tailnet only**. | WARN `reachable:unexpected` for a public port that is not expected (it says whether something listens behind it). WARN for a tailscale funnel. FAIL if UFW allows all ports. UDP listeners never WARN by themselves. |
| `docker` | For each daemon in `SECURITY_DOCKER_HOSTS`: ports published on `0.0.0.0`/`::` (Docker bypasses UFW), `--privileged`, host PID namespace, a mounted Docker socket. Host-network containers are listed. | WARN for each risky setting. A public publish shows as `reachable:docker`. INFO for host network (silence with `SECURITY_HOSTNET_OK`). |
| `tunnel` | Cloudflare tunnel hostnames. A remotely managed `cloudflared` logs `Updated to new configuration config="{...ingress...}"` when it connects. The check reads the last such line from the logs of containers that match `SECURITY_CLOUDFLARED_CONTAINERS` (or `journalctl -u cloudflared`). It prints `hostname → service` pairs only, never tokens. | INFO per hostname. WARN for a hostname missing from, or extra to, `SECURITY_EXPECT_DOMAINS`. |
| `cloudflared` | `http://127.0.0.1:20241/ready` (`readyConnections`). | FAIL at 0. WARN below `SECURITY_CLOUDFLARED_MIN_CONNECTIONS`. INFO when there are no metrics (not every stack has a tunnel). |
| `ssh` | `sshd -T`: `PermitRootLogin` must be `no`/`prohibit-password`, `PasswordAuthentication no`. Failed logins in the last 24 h, counted per connection (source IP + port), not per log line: sshd writes several lines per attempt. Then the top 3 source IPs and the usernames tried. | FAIL for root login or passwords. WARN for keyboard-interactive auth. WARN above `SECURITY_SSH_FAIL_WARN` failed logins. |
| `sshsources` | Open SSH sessions now (user, source IP, how long, tailnet or public). Accepted logins in 24 h, one entry per user + source + key: the time window (first–last) and the key, named by its comment in that user's `authorized_keys` ("NOT in authorized_keys now" if it was removed since). No counts: deploy tools open a new connection per command. A baseline of known source IPs. | WARN once for a login from an IP never seen before. |
| `accounts` | uid 0 accounts. `docker` group members (root-equivalent). NOPASSWD sudo rules in `/etc/sudoers` and `/etc/sudoers.d`. | FAIL for a uid 0 account other than root. WARN if the docker group or the NOPASSWD users differ from `SECURITY_DOCKER_USERS` / `SECURITY_SUDO_USERS` (when set). Otherwise INFO. |
| `persistence` | A baseline of hashes: every `authorized_keys*` (root and `/home/*`), `/etc/sudoers`, `/etc/sudoers.d/*`, each account's uid and shell (never password hashes), the `docker` and `sudo` group lines, and every `/etc/systemd/system/*.service` and `*.timer`. Not `/etc/cron.d` (deploys change it). | First run: INFO "baseline created". Later: WARN **once** naming the items that were added, changed or removed (names only), then the baseline is updated. |
| `secrets` | `{installDir}` is not world-readable. `crons/env.d/*` are mode 600. If other users can enter `{installDir}`: world-readable `*.env`, `*.pem`, `*.key` there. A Telegram-token-shaped string in `/etc/cron.d/*` or `/etc/airstack/stacks/*.env` (both world-readable). | WARN for loose modes. FAIL for a token; it prints the file name only, never the match. |
| `outbound` | See [Outbound tracking](#outbound-tracking). | WARN for a new process or an unusual port. |
| `processes` | Processes whose `/proc/<pid>/exe` is in `/dev/shm`, `/var/tmp`, or a hidden directory outside home directories (for example `/tmp/.x/`). Plain `/tmp` is fine (test binaries). Dot-dirs in homes (`~/.nvm`, `~/.local`) are fine. | WARN with pid and path (allow-list with `SECURITY_EXE_OK`). |
| `updates` | `unattended-upgrades` enabled and `APT::Periodic::Unattended-Upgrade "1"`. The pending-update count stays in the Maintenance block. | WARN if off. |
| `custom` | Your own checks (next section). | Whatever they print. |

## Your own checks (security.d)

After the built-ins, the script runs every **executable** `*.sh` in
`SECURITY_DIR` (default `{installDir}/security.d`), in name order.

To ship checks with a stack:

1. Create `deploy/security.d/` in the stack project. The project's `deploy/` folder is copied into the deploy tree, so it lands at `{installDir}/security.d/`.
2. Add a script. Make it executable: `chmod +x deploy/security.d/*.sh`. (Deploy refuses a non-executable `*.sh` there, and checks the VPS copy too.)
3. Deploy. The next daily report includes it.

Contract:

- Print lines `STATUS|label|detail` on stdout. `STATUS` is `OK`, `WARN`, `FAIL` or `INFO`.
- Keep it read-only and fast. Each script gets `SECURITY_CHECK_TIMEOUT` seconds (20).
- stdout only. **stderr is thrown away**, so an error message cannot leak a secret into Telegram.
- Never print secret values. Print a file name or a count instead.
- Lines that do not match the format turn into one WARN `malformed output`.
- A non-zero exit adds WARN `failed (exit N)`. A timeout adds WARN `timed out`. The run continues.
- A label that starts with `reachable:` joins the reachability block.
- The script gets the same environment as the alerter (`INSTALL_DIR`, `STATE_DIR`, `PROJECT_NAME`, ...).

Copy-paste example, `deploy/security.d/10-myapp.sh`:

```bash
#!/bin/bash
# Checks for this stack. Read-only. Prints STATUS|label|detail lines.

# The app's admin port must stay on loopback.
if ss -tlnH 2>/dev/null | awk '{print $4}' | grep -qE '^(0\.0\.0\.0|\*|\[::\]):9090$'; then
  echo "WARN|myapp|admin port 9090 listens on all interfaces"
else
  echo "OK|myapp|admin port 9090 is loopback-only"
fi

# The API key file must be private (print the mode, never the key).
f="$INSTALL_DIR/.myapp/api.key"
if [[ -f "$f" ]]; then
  m=$(stat -c %a "$f")
  [[ "$m" == 600 ]] && echo "OK|myapp|api.key mode 600" || echo "WARN|myapp|api.key mode $m (want 600)"
fi

# Our public hostname, shown in the reachability block.
echo "INFO|reachable:myapp|app.example.com via the Cloudflare tunnel"
```

## Outbound tracking

A once-a-day snapshot sees only the connections open at that second. So the 15-minute alerter
run calls `host_security.sh --sample`. The sampler:

- reads `ss -tnpH state established` (process names need root; without root they are `?`),
- keeps only **outbound** connections (the local port is not a listening port) to **public**
  addresses (it skips loopback, RFC 1918, `100.64.0.0/10`, link-local, ULA including `fd7a:`),
- records `process|ip|port|first_seen|last_seen` in `{state}/conn-seen` (mode 600),
- forgets entries not seen for `SECURITY_CONN_KEEP_DAYS` (90) and keeps at most `SECURITY_CONN_MAX` (5000),
- takes a lock, finishes in well under a second, never prints, and always exits 0.

The daily report looks at destinations **first seen in the last 24 h**:

| Case | Result |
|---|---|
| The process never connected out before (and is not in `SECURITY_KNOWN_PROCS`) | WARN `outbound:new` `proc (new process) → ip:port` |
| The remote port is not in `SECURITY_OUTBOUND_OK_PORTS` | WARN `outbound:new` `proc (unusual port) → ip:port` |
| A known process reaches a new IP on a usual port | Counted only: INFO "N new IP(s) on usual ports from known processes". Cloud IPs change all the time. |
| Remote in `SECURITY_KNOWN_REMOTES` (`ip` or `ip:port`) | Ignored |
| First `SECURITY_CONN_LEARN_DAYS` (3) days after `conn-seen` was created | INFO "learning baseline" only |

At most 8 destinations are shown, grouped by process. The check makes no network calls (no reverse DNS).

**Honest limits.** A connection that opens and closes between two samples (15 min apart) is
never seen. A process can rename itself. An attacker can use port 443 to a "new IP" and look
like normal cloud traffic. The real defense for outbound traffic is an **egress allow-list**
(firewall rules for outgoing traffic) or **auditd** (kernel audit logging of `connect()`).
This script does neither.

## Baselines and state

| File | What | Warns |
|---|---|---|
| `{state}/security-baseline` | persistence hashes | once per change |
| `{state}/ssh-sources` | known SSH source IPs | once per new IP (after the learning period) |
| `{state}/conn-seen` | outbound destinations | while first seen in the last 24 h (after the learning period) |

`{state}` is `$STATE_DIR/host-health` (for example `/home/deploy/.stack-state/host-health`), or
`/var/lib/host-security` when `STATE_DIR` is not set. Override with `SECURITY_STATE_DIR`.
Files are mode 600. Note: deploys reset ownership inside `{installDir}` to the stack owner, so the
stack owner could edit these files. They detect drift, not a determined local attacker.

To accept a change on purpose, do nothing: the WARN shows once and the baseline moves on.
To start over, delete the file. The next run creates it again.

## Knobs

Set them in the `env:` of the `host_alerter_report` cron (and of `host_alerter` for the sampler knobs) in `stack.yml`.
A number knob with a bad value stops the script with exit 2 and a clear message, and the report shows "Security checks failed to run".

| Knob | Default | Meaning |
|---|---|---|
| `SECURITY_REPORT` | `auto` | alerter: `auto` = on when the script exists; `false` = off; `true` = on |
| `SECURITY_SCRIPT` | `{installDir}/plugins/cron/host-status/host_security.sh` | alerter: script path |
| `SECURITY_SAMPLE` | `true` | alerter: 15-min run calls `--sample` |
| `SECURITY_BUILTIN` | `true` | `false` = only custom checks |
| `SECURITY_SKIP` | (none) | built-in checks to skip: `firewall tailscale reachability docker tunnel cloudflared ssh sshsources accounts persistence secrets outbound processes updates custom` |
| `SECURITY_DIR` | `{installDir}/security.d` | custom checks |
| `SECURITY_CHECK_TIMEOUT` | 20 | seconds per custom check |
| `SECURITY_PUBLIC_PORTS` | sshd ports (`sshd -T`, else 22) as `P/tcp`, plus `41641/udp` when tailscale is installed | ports allowed to be open to the internet: `222`, `222/tcp`, `41641/udp` |
| `SECURITY_DOCKER_HOSTS` | `unix:///var/run/docker.sock` | daemons to inspect; add rootless ones, e.g. `unix:///run/user/1002/docker.sock` |
| `SECURITY_HOSTNET_OK` | (none) | container-name globs whose host network is fine |
| `SECURITY_SSH_FAIL_WARN` | 200 | failed logins (connections) per 24 h before WARN |
| `SECURITY_DOCKER_USERS` | (none) | expected docker group members |
| `SECURITY_SUDO_USERS` | (none) | expected NOPASSWD sudo users |
| `SECURITY_OUTBOUND_OK_PORTS` | `22 53 80 123 222 443 853 8443` | usual outbound ports |
| `SECURITY_KNOWN_PROCS` | (none) | processes allowed to reach new destinations |
| `SECURITY_KNOWN_REMOTES` | (none) | `ip` or `ip:port` allowed |
| `SECURITY_CONN_LEARN_DAYS` | 3 | learning period for `conn-seen` and `ssh-sources` |
| `SECURITY_CONN_KEEP_DAYS` | 90 | forget destinations not seen this long |
| `SECURITY_CONN_MAX` | 5000 | max remembered destinations |
| `SECURITY_EXE_OK` | (none) | executable-path globs that are fine (`processes`) |
| `SECURITY_CLOUDFLARED_METRICS_PORT` | 20241 | cloudflared metrics port |
| `SECURITY_CLOUDFLARED_MIN_CONNECTIONS` | 2 | WARN below this |
| `SECURITY_CLOUDFLARED_CONTAINERS` | `*cloudflared*` | container-name globs to read the tunnel config from |
| `SECURITY_CLOUDFLARED_LOG_LINES` | 5000 | log lines searched |
| `SECURITY_TUNNEL_DOMAINS` | (none) | static hostname list when the logs show none |
| `SECURITY_EXPECT_DOMAINS` | (none) | expected tunnel hostnames (WARN on missing or extra) |
| `SECURITY_TELEGRAM_MAX_LINES` | 25 | section line cap |
| `SECURITY_TELEGRAM_MAX_INFO` | 8 | INFO line cap |
| `SECURITY_TELEGRAM_BUDGET` | 3000 | section character cap (the alerter passes what is left of 3900) |
| `SECURITY_STATE_DIR` | `$STATE_DIR/host-health` | where baselines live |

Test hooks (not for production): `SECURITY_FIXTURE_DIR` (canned command output, see
`test/cli/plugins/host-security.test.ts`), `SECURITY_NOW`, `SECURITY_NO_JQ`, `SECURITY_CRON_DIR`.

## Silencing a check

Pick the narrowest knob:

1. A known-good value: set the matching knob (`SECURITY_PUBLIC_PORTS`, `SECURITY_HOSTNET_OK`, `SECURITY_KNOWN_PROCS`, `SECURITY_EXE_OK`, ...).
2. A whole check that does not apply to this box: `SECURITY_SKIP="cloudflared tunnel"`.
3. The whole section: `SECURITY_REPORT=false` on `host_alerter_report`.

## Limits: what it does NOT detect

- It runs once a day (plus the 15-min sampler). It is not real-time.
- Root can edit the baselines, the script, or `ss` itself. A rootkit hides from all of it.
- Short-lived outbound connections between samples. Traffic inside Docker bridge networks (their own network namespaces). UDP traffic.
- File changes outside the baseline list (binaries in `/usr`, cron jobs, shell profiles, `ld.so.preload`, kernel modules).
- Fileless malware (`memfd`), processes that rename themselves, deleted binaries outside the watched dirs.
- Web-app attacks behind the tunnel, stolen credentials used from an IP you already know.
- Tunnel hostnames when `cloudflared` has not logged its config recently (use `SECURITY_TUNNEL_DOMAINS`).

For stronger coverage, add an egress allow-list, auditd rules, and a file integrity tool (AIDE).
