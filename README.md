# airstack

**Run a fleet of VPS machines from one git repo. Safe for humans, made for AI agents.**

airstack turns a plain Ubuntu VPS into a hardened, monitored Docker host, and keeps it that way.
You describe your machines and stacks in a **fleet repo**. airstack sets up the machines, deploys
the stacks, keeps a history of every config change on each machine, and tells you when something
drifts, breaks or becomes public by mistake.

```console
$ airstack deploy web-1
ok   web-1: airstack up to date: 0.1.0
ok   web-1/airstack (machine): deployed
ok   web-1/hello: deployed
ok   web-1/cliproxy: deployed
```

One binary. Two modes. No daemon to run, no control plane to host, no database.

---

## Why airstack

A VPS is cheap and fast. The work starts after the first deploy:

- **Config drifts.** Someone fixes a file on the box at 2 AM. The next deploy overwrites it, and
  nobody knows.
- **Secrets leak.** Tokens end up in a git commit, a log line or a chat with an AI assistant.
- **Hardening is a checklist** that nobody repeats on machine number three.
- **"Is it still okay?"** takes SSH, five commands and a good memory.
- **AI agents need guard rails.** They work fast. They need clear output, clear exit codes, and
  tools that cannot leak a secret or wipe a box edit.

airstack handles all of these from one repo that you already know how to review.

## What you get

- **One fleet repo, many machines.** Machines, reusable stacks, your own plugins and templates,
  all in git. Run the same stack many times on one machine. Each instance gets its own user,
  directory and Docker Compose project.
- **Secrets that stay secret.** Secrets live in the fleet repo's `.airstack/secrets/` folder,
  which is never committed. Config refers to them as `${NAME}`. airstack never prints a secret
  value, and every output on a machine goes through a redactor first.
- **First-time setup in one command.** `airstack deploy web-1 --install` takes a fresh Ubuntu box
  through base packages, SSH hardening, a firewall, Docker, rootless Docker for dev users, a
  reboot and a safe SSH lockdown. It closes the old SSH port only after the new port answers.
- **Config history on every machine.** Each machine keeps a root-only git history of its managed
  files: every deploy, every edit made on the box, every rollback.
- **A drift guard.** Deploy refuses to overwrite an edit made on the machine that you did not
  pull first. `airstack pull web-1` shows the edit as a redacted diff. You decide what to keep.
- **Repair on the box.** `airstack machine status | check | report | logs | config | history |
  apply | rollback` works on the machine itself, also for team members without full sudo.
- **Cloudflare Access guard.** Every public tunnel route must be behind Cloudflare Access.
  Deploy refuses a public route. The 15-minute scan alerts you, or stops the tunnel if you ask it to.
- **Daily health report on Telegram.** Short by default: problems first, then one line for all
  the checks that passed. Security checks are included: firewall, SSH, accounts, persistence,
  secrets on disk and outbound connections.
- **Self-checks.** `airstack doctor` checks your controller, your fleet repo (including secret
  values that slipped into a commit) and each machine. `--fix` repairs the safe things.

## Quick start

You need a laptop or workstation (macOS or Linux), and one fresh Ubuntu VPS that you can reach
over SSH with a key.

1. Install airstack for your user. It needs no sudo and writes only to `~/.local`:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/airstack/airstack/main/install.sh | sh
   ```

2. Create a fleet repo:

   ```sh
   airstack init my-fleet && cd my-fleet && git init
   ```

3. Describe your machine. Copy `machines/web-1.yaml.example` to `machines/web-1.yaml`. Set the
   IP address, the SSH key and the users. Put secrets in `.airstack/secrets/_fleet.jsonc`.

4. Check the fleet. The check runs offline:

   ```sh
   airstack fleet check
   ```

5. Set up the machine and deploy:

   ```sh
   airstack deploy web-1 --install
   ```

6. After that, a deploy is one command:

   ```sh
   airstack deploy web-1          # or: airstack deploy --all, airstack deploy 'web-*'
   ```

A complete example is in [`examples/fleet/`](examples/fleet/).

## How it works

```
 your laptop (controller)                         each VPS (node)
 ┌──────────────────────────┐   SSH + rsync    ┌──────────────────────────────────┐
 │ fleet repo (git)         │ ───────────────▶ │ /usr/local/bin/airstack          │
 │  airstack.yaml           │                  │ /etc/airstack/machine.yaml       │
 │  machines/web-1.yaml     │  airstack pull   │ /srv/airstack/                   │
 │  stacks/hello/stack.yaml │ ◀─────────────── │   machine/        cron, tunnel   │
 │  plugins/  templates/    │  (redacted diff) │   stacks/<name>/  one per stack  │
 │  .airstack/ (ignored)    │                  │   .stack/         config history │
 └──────────────────────────┘                  └──────────────────────────────────┘
```

- The **controller** is your laptop. It holds the fleet repo and runs `deploy`, `pull`, `fleet`
  and `ssh`. Nothing runs in the background.
- A **node** is a managed VPS. Deploy puts the matching airstack build on it. Node verbs
  (`airstack machine …`) work there. Controller verbs are off.
- One root-owned file sets the mode: `/etc/airstack/machine.yaml`. No file means controller.
- Each machine runs one **machine unit** (machine-wide services, such as the Cloudflare tunnel
  and the host checks) and one **unit per stack instance**, each with its own Docker Compose project.

A fleet repo looks like this:

```
my-fleet/
├── airstack.yaml                 # fleet name + pinned airstack version
├── machines/web-1.yaml           # one file per machine
├── stacks/hello/stack.yaml       # reusable stacks (with their templates)
├── plugins/  templates/          # your own plugins and shared templates
└── .airstack/                    # gitignored: secrets, staged deploys, pulled files, logs
```

## A day with airstack

```console
$ airstack fleet check
ok   web-1: 2 stack instance(s), 2 machine plugin(s)

$ airstack deploy web-1 --stack hello
fail web-1/hello: pre-sync: box edits would be lost: docker-compose.yml. Run `airstack pull <machine>` …

$ airstack pull web-1
ok   web-1: pulled history 3eeb8c66 into .airstack/pull/web-1
warn hello: 1 file(s) on the machine differ from the fleet: docker-compose.yml
--- fleet/docker-compose.yml
+++ machine/docker-compose.yml
@@ -12,3 +12,4 @@ services:
+      API_TOKEN: "[redacted:API_TOKEN:9f2c41]"

$ airstack ssh web-1 -- airstack machine report
📊 web-1 — Daily Status
✅ All checks passed
✅ 18 passed: Disk, Memory, Load, Docker, Containers, Firewall, SSH, Cloudflare Access, …
```

## Built for AI agents

airstack is agent-first. An agent can use it without special prompts:

- **Stable output.** Every line starts with `ok`, `warn`, `fail` or `->` (the next command to
  run). Exit codes: `0` ok, `1` warnings, `2` failures, `3` usage error or blocked verb.
- **No secrets in output.** Config views show `${NAME}`, never the value. Node output is redacted
  with stable markers such as `[redacted:TELEGRAM_BOT_TOKEN:d16985]`, so a diff still shows when a
  secret changed.
- **Mistakes are hard to make.** Deploy refuses to overwrite unpulled box edits, refuses public
  tunnel routes, and refuses to run when `.airstack/` is not gitignored. Node verbs refuse on a
  laptop, and deploy refuses on a node.
- **Self-describing.** `airstack whoami` tells you where you are, which verbs are on, and why.
  `airstack help` and `--help` on each verb print the usage.
- **Docs that an agent can read.** [`docs/cli/`](docs/cli/) has one page per verb, with real
  output. [`AGENTS.md`](AGENTS.md) has the rules for agents that work on airstack itself.

## Safety model

- The CLI guards against accidents. **It is not a security boundary.** The real limits are Unix
  permissions and sudo rules. The config history and the redaction data on a machine are
  root-only. Members of `airstack-admin` may run only `airstack machine …` and `airstack doctor`
  as root.
- Only root-owned config can widen what airstack may do. User config and environment variables
  can only turn verbs off.
- A node does not download its own airstack. The controller pushes a checksum-verified build.
  Self-updates on a node stay off unless the machine marker turns them on.
- `install.sh` never uses sudo, and it refuses to run on a node.

## Requirements

- **Controller:** macOS or Linux (x64 or arm64) with `ssh`, `rsync`, `git` and `tar`.
- **Nodes:** Ubuntu, reachable over SSH with a key, with a sudo user for the first install.
  Tested on Ubuntu 26.04 (arm64). Release builds also exist for x64.
- Optional: a Cloudflare tunnel token, a Tailscale auth key, and a Telegram bot for reports.

## Documentation

| Topic | Where |
|---|---|
| Every verb, with examples | [docs/cli/](docs/cli/) |
| A complete example fleet | [examples/fleet/](examples/fleet/) |
| What goes where on a machine | [docs/LAYOUT.md](docs/LAYOUT.md) |
| Host security checks and the Access guard | [docs/HOST-SECURITY.md](docs/HOST-SECURITY.md) |
| Telegram alerts and the daily report | [docs/TELEGRAM.md](docs/TELEGRAM.md) |
| Write your own plugins | [docs/plugin-guide.md](docs/plugin-guide.md) |
| Changes per version | [CHANGELOG.md](CHANGELOG.md) |

## Develop

```sh
bun install
bun cli/index.ts help             # run from source
bun run test                      # vitest
bun run typecheck
sh devutils/leak-scan.sh          # no real IPs or tokens in the repo
bun devutils/release/build.ts     # release tarballs + SHA256SUMS in dist/
```

## Status and license

airstack 0.1.0 is the first public release. It runs real machines today. The config format can
still change before 1.0.

airstack is part of **Airship OS**. It is open source under the [MIT License](LICENSE.md).
