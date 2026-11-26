# AGENTS.md

airstack manages a fleet of VPS machines from one fleet repo. One binary runs in two modes:
**controller** (a fleet owner's machine: deploys, fleet management) and **node** (a managed VPS:
local health, config history, repair). This repo is the core. A user's fleet repo (machines,
stacks, fleet plugins, secrets) is separate and installs airstack.

Current work: `plans/phase-1.md`.

## Ground rules

1. **The CLI guards against accidents. It is NOT a security boundary.** Anyone can copy the binary
   and remove a check. The real limits are Unix permissions, the stack-user-only `.stack/.git`, and
   sudoers rules. Never weaken those because "the CLI checks it". Never add a CLI check and call it
   security.
2. **Only root-owned config can widen what the CLI may do.** `/etc/airstack/machine.yaml` decides
   node mode and roles. User config (`~/.config/airstack/`) and `AIRSTACK_*` env vars may only turn
   things off.
3. **Bare top-level verbs act on this machine only.** Anything that touches another machine lives
   under `fleet`, `deploy` or `ssh`. No `--machine` / `--on` flags on local verbs. To run a node verb
   remotely: `airstack ssh <machine> -- airstack …`.
4. **No directory walks.** The fleet is `./airstack.yaml`, `--fleet <path>`, or the `fleet:` default
   in `~/.config/airstack/config.yaml`. Never a parent dir. On a node, `./airstack.yaml` is ignored.
5. **Never litter a controller.** A controller install writes one binary. Config is written only when
   the user sets something. All fleet state lives in the fleet repo's gitignored `.airstack/`.
6. **No real fleet values in this repo.** Tests use fixtures under `test/fixtures/` with documentation
   addresses (`203.0.113.0/24`, `198.51.100.0/24`, `100.64.0.0/10`). Before committing, run the
   local leak scan if present: `git grep -nIE -f .git/info/leakscan` (exit 1 = clean).
7. **Agent-first output.** Concise text, stable line prefixes (`ok`, `warn`, `fail`, `->` next step),
   exit codes 0 ok / 1 warnings / 2 failures / 3 usage or blocked. All output goes through one
   formatter so `--json` can be added later. A blocked verb prints one line naming the file and key
   that blocked it.

## Config conventions

- `.yaml`, never `.yml`.
- `stack: name` and plugin `name` resolve in the fleet repo only. Built-ins are always `airstack/name`.
  Never fall back from a bare name to a built-in.
- Merge: maps deep-merge (higher layer wins), lists replace, `null` deletes.

## Dev

- Runtime: Bun. Tests: `bun run test` (vitest). Types: `bun run typecheck`.
- Shell scripts deployed to VPSes are POSIX `sh` or bash and are tested on macOS through fixtures.
- Do not run deploys against a real machine without the owner's go-ahead.
