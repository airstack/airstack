# Changelog

All notable changes to airstack. Versions follow [semantic versioning](https://semver.org).

## 0.1.0

The first public release.

### Fleet

- One fleet repo manages many VPS machines: `airstack.yaml`, `machines/<machine>.yaml`,
  reusable `stacks/<stack>/stack.yaml`, your own `plugins/` and `templates/`.
- Secrets stay in the fleet repo but are never committed: `.airstack/secrets/*.jsonc`, used as
  `${NAME}` in config. Output never prints a secret value.
- `airstack fleet check` validates the fleet offline: references, plugin scopes, secrets, users,
  host port collisions, rootless network rules.
- One machine can run many instances of the same stack, each with its own compose project, run
  user and install dir.
- `airstack init` creates a new fleet repo.

### Deploy

- `airstack deploy <machine>` renders, syncs and starts every unit of a machine (the machine unit
  plus one unit per stack instance). `--stack`, `--stage`, `--dry-run`, `--force`, `--prune`.
- `airstack deploy <machine> --install` sets up a fresh Ubuntu VPS: base packages, hardening,
  Docker, rootless Docker for dev users, verify, reboot, then SSH lockdown to the final port.
- Deploy puts the pinned airstack build on each machine (`/usr/local/lib/airstack/versions/`).
- Drift guard: deploy refuses to overwrite edits made on the machine that nobody pulled.
  `--force` overrides; the edits stay in the machine's config history.

### Config history and node verbs

- Each machine keeps a root-only git history of its managed files (`<root>/.stack`): deploys,
  edits made on the machine, rollbacks.
- `airstack pull <machine>` copies the live files to the controller and shows a redacted diff.
- Node verbs: `airstack machine status | check | report | logs | config read | config diff |
  history | snapshot | apply | restart | rollback`. Members of `airstack-admin` can run them
  without full sudo.
- Redaction removes secrets from every node output: known secret values, plugin rules and
  common token shapes. Each secret becomes a stable `[redacted:<name>:<hash>]` marker.

### Security

- Cloudflare Access guard: every public tunnel route must be behind Cloudflare Access. Deploy
  refuses (or warns) and the 15-minute scan alerts (or stops the tunnel) when a route is public.
- Daily host report on Telegram: short by default (problems plus a one-line summary).
  `airstack machine report --full` shows every check.
- Host security checks: firewall, SSH, accounts, persistence, secrets on disk, outbound
  connections, Tailscale, Docker.

### Tools

- `airstack doctor [--fix]` checks a controller, a fleet repo or a node.
- `airstack versions | update | install <version>`; `airstack fleet update | install`.
- `install.sh` installs airstack for your user only (`~/.local`), checks the release checksum,
  and refuses to run on a node.
