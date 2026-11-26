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
- [ ] `/srv/airstack/.stack/.git` (stackroot, 700): managed files per unit (rendered + seeded), live
      edits auto-committed (`box edit`), deploy commits `deploy <fleet sha>`.
- [ ] File modes per plugin: rendered / seeded (cliproxy config.yaml) / state (auths, data, logs).
- [ ] `incoming/<source>` branch + three-way merge in a separate worktree; `.stack-base` in
      `.airstack/deploy/<machine>/`; drift guard (refuse to overwrite box edits; `--force`).
- [ ] `airstack pull <machine>`: box → `.airstack/deploy/<machine>/` + redacted diff.
- [ ] Redaction library (secret values from the secrets file, plugin redactors incl. cliproxy
      config.yaml keys, generic key shapes in comments too); short hash markers.
- [ ] Tests + live test (edit config.yaml on the box → pull shows redacted diff; deploy refuses to
      clobber; rollback).

## 3. Phase 3 — node CLI + binary on nodes
- [ ] `bun build --compile` release builds (linux x64/arm64, darwin arm64), embedded built-in
      plugins/templates/stacks; `install.sh` (controller: user-local bin; node: via deploy only).
- [ ] deploy pushes the pinned binary to nodes (checksum, /usr/local/lib/airstack/versions/<v>,
      /usr/local/bin/airstack symlink); `update` / `install <v>` / `versions` / `fleet update` /
      `fleet install <v> <m>`; node source updates off by default.
- [ ] Node verbs: `airstack machine status|check|report|logs|config read|config diff|history`,
      repair verbs `restart|snapshot|apply|rollback` (airstack-admin group), sudo helper for reads.
- [ ] `airstack doctor [--fix]` (local + `--fleet`), `airstack status` local/fleet.
- [ ] Shorter daily report (owner: still too much info): checks only problems + a one-line ✅
      summary; full detail via `airstack machine report --full`.

## Release readiness
- [ ] Phase-1 leftovers: fleet check port collisions + rootless/network checks; box compose file
      name; host-status scripts not copied into every unit.
- [ ] README (what/why/quickstart), docs for every verb, example fleet (docs or `airstack init`),
      LICENSE check, CHANGELOG, version 0.1.0 → release notes, CI workflow (tests + leak scan).
- [ ] Full end-to-end run on airstack-test1 from a clean state where feasible.

## 4. HOLD — production-box migration (tomorrow, with the owner)
