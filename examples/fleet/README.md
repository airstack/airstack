# Example fleet

A complete, minimal fleet repo. Copy it, edit it, and deploy it.

It has:

- one machine, `web-1` (`machines/web-1.yaml`), with host crons and a Cloudflare Tunnel,
- one fleet stack, `hello` (`stacks/hello/`): a tiny HTTP echo service (`traefik/whoami`) on a
  loopback port,
- two instances of that stack: `hello` (run by the stack owner) and `hello-dev` (run by a dev
  account in rootless Docker),
- the built-in stack `airstack/cliproxy`, commented out,
- a secrets template (`.airstack/secrets/_fleet.example.jsonc`).

All addresses and names are documentation values (`192.0.2.10`, `example.com`). Replace them.

## Files

| Path | What |
|---|---|
| `airstack.yaml` | Fleet root marker: the airstack version pin and the fleet name. |
| `.gitignore` | Keeps `.airstack/` out of git (except the secrets template). |
| `machines/web-1.yaml` | The machine: host, SSH, users, machine plugins, stack instances. |
| `stacks/hello/stack.yaml` | The stack: default values, templates, sync rules. |
| `stacks/hello/compose.yaml.hbs` | The compose template. Rendered once per instance. |
| `.airstack/secrets/_fleet.example.jsonc` | Secrets template with placeholder values. |

## Walkthrough

You need: airstack on your computer, `ssh`, `rsync`, `git`, and a fresh Ubuntu VPS that you can
reach as `root` with your SSH key.

1. Copy the example to a new directory:

   ```sh
   cp -R examples/fleet ~/my-fleet
   cd ~/my-fleet
   git init
   ```

2. Make the secrets file from the template:

   ```sh
   cp .airstack/secrets/_fleet.example.jsonc .airstack/secrets/_fleet.jsonc
   chmod 600 .airstack/secrets/_fleet.jsonc
   ```

3. Put your real values in `.airstack/secrets/_fleet.jsonc`. Never commit this file.

4. Edit `machines/web-1.yaml`:
   1. Set `host.ip` to the address of your VPS.
   2. Set `host.ssh.key` to your private SSH key.
   3. Set `host.timezone` and `defaultTimezone`.
   4. To rename the machine, rename the file too. `machine:` and the file name must be the same.

5. Check the fleet:

   ```
   $ airstack fleet check
   ok   web-1: 2 stack instance(s), 2 machine plugin(s)
   ```

6. Look at the rendered files (this connects to no machine):

   ```sh
   airstack deploy web-1 --stage
   cat .airstack/deploy/web-1/hello/docker-compose.yml
   ```

7. Set up the fresh box and deploy:

   ```sh
   airstack deploy web-1 --install
   ```

8. Check the result:

   ```sh
   airstack status web-1
   airstack ssh web-1 -- curl -s http://127.0.0.1:8080
   ```

## What `--install` does here

The machine file describes the finished machine: SSH as `adminroot` on port 222. The fresh box
answers as `root` on port 22. `--install` creates the users, hardens SSH, installs Docker (and
rootless Docker for `deployuser`), reboots, closes port 22, writes `/etc/airstack/machine.yaml`,
and deploys. See [docs/cli/deploy.md](../../docs/cli/deploy.md#install-sequence).

## Cloudflare Tunnel

The `airstack/cloudflare` plugin runs cloudflared in the machine project `airstack`. You add the
public hostnames in the Cloudflare dashboard. The `hello` instance joins the shared `airstack`
network (`tunnel: true`), so a route can point to `http://hello-whoami:8080`.

`access.required: true` and `onDeploy: refuse`: after deploy, airstack checks each public hostname.
If a hostname answers without Cloudflare Access, deploy stops cloudflared and fails. Add an Access
application for the hostname, or list it in `access.exempt`.

If you do not use Cloudflare, delete the `airstack/cloudflare` block and the
`CLOUDFLARE_TUNNEL_TOKEN` secret. Then set `tunnel: false` (or delete it) on `hello`.

## Expected warnings and errors

- Without `.airstack/secrets/_fleet.jsonc` (step 2), `airstack fleet check` fails (exit 2):

  ```
  fail .airstack/secrets/web-1.jsonc CLOUDFLARE_TUNNEL_TOKEN: missing secret (referenced in machines/web-1.yaml, no default)
  ```

  The message names `web-1.jsonc`, the per-machine file. `_fleet.jsonc` works too.

- `airstack doctor` warns `secrets files readable by others: _fleet.example.jsonc`. git does not
  keep mode 600, so the template is mode 644 after a copy or clone. It holds no real secrets.
  `airstack doctor --fix` sets it to 600.

## The cliproxy instance

`airstack/cliproxy` is a built-in stack (CLIProxyAPI on port 8317). Before the first deploy, put
its `config.yaml` on the machine at `<installDir>/.cliproxyapi/config.yaml`, or deploy fails.
Then remove the `#` from the `cliproxy:` lines in `machines/web-1.yaml`. See
[docs/CLIPROXYAPI.md](../../docs/CLIPROXYAPI.md).

## Next steps

- [docs/cli/](../../docs/cli/README.md): every verb.
- [docs/LAYOUT.md](../../docs/LAYOUT.md): users and paths on a machine.
- [docs/TELEGRAM.md](../../docs/TELEGRAM.md): Telegram alerts from the host crons.
