# airstack — release 1 (overnight run, 2026-11-26)

Mandate from the owner: work through items 1–3 below without stopping for input, test everything on
`airstack-test1`, and leave airstack release-ready for the public. HOLD item 4 (moving the owner's production box onto airstack): the owner does that with us tomorrow. Never touch the production box tonight.

Test machine: `airstack-test1` (OrbStack VM, locked down: `ssh -p 222 adminroot@airstack-test1.orb.local`,
`orb shell` is the fallback). Dev fleet: `../airstack-fleet-dev` (machine `airstack-test1`: cliproxy +
usage-server, cloudflared with Access-protected route, tailscale, host crons, Telegram alerts).
Rules: AGENTS.md (CLI guards accidents, not a security boundary; no real fleet values in this repo;
leak scan before commits). Commit + push to airstack/airstack as work lands.

## 1. Cloudflare Access enforcement
- [x] `onDeploy: refuse|warn`: after the machine unit starts cloudflared, probe every route
      (same classifier as host_security.sh); refuse = stop cloudflared + fail the deploy naming the
      route; unknown never refuses (warn).
- [x] `onScan: stop|alert`: 15-min host_alerter stops `CF_CONTAINER` on a definite FAIL, alerts
      "tunnel stopped"; next deploy starts it (and refuses again if still public).
- [x] Tests + live test on airstack-test1 (pass path live; stop → flag → deploy restarts → flag clears, live with a fake FAIL; refuse path by unit test: no way to make a route public without the dashboard).

## 2. Phase 2 — config history and sync (plans/phase-1.md §0 row 2)
- [x] `<root>/.stack` git store (root 700; it holds live files with secrets and dev-user files, so
      root, not stackroot): work tree mirrors managed files per unit (`machine/`, `stacks/<inst>/`).
      Box edits are committed on every snapshot / drift check; deploys commit `deploy <unit> (fleet <sha>)`;
      `refs/airstack/deployed/<slot>` marks the last deploy.
- [x] File modes: rendered (staged tree, deploy overwrites), tracked (plugin `tracked:`; cliproxy
      config.yaml + usage-server.env), state (never tracked). List in `.stack-config/managed.json`.
- [x] Drift guard, as a three-way compare instead of a merge: per file deploy writes, live vs
      incoming vs last deploy vs pulled base (`.airstack/deploy/<machine>/.stack-base`). Refuse unless
      `--force`. DECISION: no automatic merge into rendered files — a merged result cannot be
      reproduced from the fleet and the next deploy would drop it; the agent promotes edits into
      templates after `pull` instead. No `incoming/` branch needed for that.
- [x] `airstack pull <machine>`: snapshot on the box, copy to `.airstack/pull/<machine>/`, write
      `.stack-base`, redacted diff fleet render → machine; box-owned files diff against the last pull.
- [x] Redaction library `cli/lib/redact/` (secret values, plugin rules, generic keys + shapes, also in
      comments; `[redacted:<label>:<sha6>]`). Node side gets secret values via `/etc/airstack/redact.json`.
- [x] Tests (unit + real git) + live test on airstack-test1: box edit → `machine config diff` →
      deploy refused → pull shows the diff → deploy allowed → rollback both ways.

## 3. Phase 3 — node CLI + binary on nodes
- [x] Release builds (`devutils/release/build.ts`, 4 targets, SHA256SUMS); built-in plugins bundled
      statically, core files shipped next to `bin/`; `install.sh` (controller only, user-local).
- [x] deploy / `fleet update` / `fleet install <v>` push the build (sha256-checked, versions dir,
      symlink, keep 3); controller `versions` / `update` / `install <v>`; nodes refuse unless
      `update.allowSourceUpdate: true` in the marker. Source checkouts build the node binary on demand.
- [x] Node verbs `airstack machine …` (all listed), sudo re-exec, `airstack-admin` group +
      visudo-checked sudoers rule (`host.users.admins`).
- [x] `airstack doctor [--fix]` (controller + fleet repo + `doctor <machine>|--all` over SSH; node).
      `airstack status` (fleet) unchanged; node status is `airstack machine status`.
- [x] Shorter daily report: problems + "✅ N passed: names"; `--full` / `REPORT_FULL=true` for all.

## Release readiness
- [x] fleet check port collisions + rootless/network checks (`cli/lib/fleet-lint.ts`, also in deploy).
- [x] Host-status scripts ship only to units with host_ crons (`deployExclude`).
- [x] DECISION: box compose file stays `docker-compose.yml` (renaming breaks running machines and the
      host scripts; no user-visible gain).
- [x] CHANGELOG, CI + release workflows in `.github/workflows/` (moved there once the token had
      the workflow scope).
- [x] README, docs for every verb (`docs/cli/`), example fleet (`examples/fleet/`), `airstack init`.
- [x] LICENSE: MIT (owner decision, 2026-11-26).
- [x] End-to-end from a clean VM (airstack-test2, fresh OrbStack Ubuntu 26.04 arm64): one `deploy --install` ran base, harden, docker, rootless, verify, reboot, finalize (port 22 closed), marker, binary, machine unit + 2 stacks (root daemon + rootless dev user), HTTP 200 on both; doctor clean; airstack-admin member reads history without full sudo.

## 4. HOLD — production-box migration (tomorrow, with the owner)
