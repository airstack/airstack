import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeTmpDir } from '../helpers'

// host_security.sh is portable bash (3.2+). Most tests use SECURITY_FIXTURE_DIR: canned command
// output (taken from a real, healthy testbox) instead of running ufw/ss/docker/..., so they pass on macOS.
const DIR = join(import.meta.dirname, '../../../cli/plugins/cron/deploy/host-status')
const SCRIPT = join(DIR, 'host_security.sh')
const ALERTER = join(DIR, 'host_alerter.sh')
const LINE = /^(OK|WARN|FAIL|INFO)\|[^|]*\|[^|]*$/
const HAS_TIMEOUT = spawnSync('sh', ['-c', 'command -v timeout']).status === 0
const DAY = 86400
const NOW = 1_800_000_000

// --- Fixtures: a healthy testbox -------------------------------------------------
const HEALTHY: Record<string, string> = {
  ufw_status: `Status: active
Logging: on (low)
Default: deny (incoming), allow (outgoing), deny (routed)
New profiles: skip

To                         Action      From
--                         ------      ----
222/tcp                    ALLOW IN    Anywhere
8317/tcp on tailscale0     ALLOW IN    Anywhere                   # stack-cli-tailscale
41641/udp                  ALLOW IN    Anywhere                   # tailscale wireguard
3773/tcp on tailscale0     ALLOW IN    Anywhere                   # t3code-tailnet
222/tcp (v6)               ALLOW IN    Anywhere (v6)
8317/tcp (v6) on tailscale0 ALLOW IN    Anywhere (v6)              # stack-cli-tailscale
41641/udp (v6)             ALLOW IN    Anywhere (v6)              # tailscale wireguard
3773/tcp (v6) on tailscale0 ALLOW IN    Anywhere (v6)              # t3code-tailnet
`,
  iptables_input: '-P INPUT DROP\n-A INPUT -j ufw-before-input\n',
  iptables_ts: 'iptables: Bad rule (does a matching rule exist in that chain?).\n',
  'iptables_ts.rc': '1',
  ss_listen: `LISTEN 0 4096 0.0.0.0:222 0.0.0.0:*
LISTEN 0 4096 127.0.0.53%lo:53 0.0.0.0:*
LISTEN 0 4096 100.64.0.10%tailscale0:60165 0.0.0.0:*
LISTEN 0 2048 127.0.0.1:18090 0.0.0.0:*
LISTEN 0 4096 100.64.0.10%tailscale0:3773 0.0.0.0:*
LISTEN 0 511 127.0.0.1:3773 0.0.0.0:*
LISTEN 0 4096 [::]:222 [::]:*
LISTEN 0 4096 [fd7a:115c:a1e0::d82b:d13c]%tailscale0:3773 [::]:*
LISTEN 0 4096 *:8317 *:*
LISTEN 0 4096 *:20241 *:*
`,
  ss_est: `0 0 127.0.0.1:37854 127.0.0.1:44671 users:(("node-MainThread",pid=16076,fd=95))
0 520 203.0.113.10:222 198.51.100.20:59282 users:(("sshd-session",pid=300,fd=9),("sshd-session",pid=301,fd=9))
0 0 203.0.113.10:40142 192.0.2.50:443 users:(("node-MainThread",pid=16076,fd=120))
0 0 [2001:db8:101:200::1a7f]:55078 [2001:db8:ffff::10]:443 users:(("CLIProxyAPI",pid=2281,fd=14))
0 0 [::ffff:127.0.0.1]:8317 [::ffff:127.0.0.1]:56280 users:(("CLIProxyAPI",pid=2281,fd=20))
0 0 10.0.0.5:40000 10.0.0.9:9999 users:(("lan",pid=7,fd=3))
`,
  sshd_T: 'port 222\nlistenaddress [::]:222\npermitrootlogin no\npasswordauthentication no\nkbdinteractiveauthentication no\n',
  cloudflared_ready: '{"status":200,"readyConnections":4,"connectorId":"edabb280"}\n',
  cloudflared_logs: 'noise line\n2026-11-25T07:05:49Z INF Updated to new configuration config="{\\"ingress\\":[{\\"hostname\\":\\"old.example.com\\",\\"service\\":\\"http://localhost:1\\"}]}" version=5\n'
    + '2026-11-25T07:05:49Z INF Updated to new configuration config="{\\"ingress\\":[{\\"hostname\\":\\"cliproxy.example.com\\",\\"service\\":\\"http://localhost:8317\\"},{\\"service\\":\\"http_status:404\\"}],\\"warp-routing\\":{\\"enabled\\":false}}" version=6\n',
  tailscale_status: `{
  "Version": "1.104.7",
  "BackendState": "Running",
  "Self": {
    "HostName": "testbox",
    "Tags": [
      "tag:cliproxy",
      "tag:server"
    ],
    "TailscaleIPs": ["100.64.0.10"]
  },
  "Peer": { "nodekey:x": { "Tags": ["tag:other"] } }
}
`,
  tailscale_serve: '{\n  "TCP": {\n    "3773": {\n      "TCPForward": "127.0.0.1:3773"\n    }\n  }\n}\n',
  journal_ssh: 'Nov 25 00:14:09 testbox sshd-session[1]: Accepted publickey for adminroot from 198.51.100.20 port 55905 ssh2: ED25519 SHA256:x\n'
    + 'Nov 25 07:45:11 testbox sshd-session[2]: Accepted publickey for adminroot from 198.51.100.20 port 55912 ssh2: ED25519 SHA256:x\n',
  'authorized_fingerprints.adminroot': '256 SHA256:x laptop key (ED25519)\n',
  ss_ssh: '0 0 203.0.113.10:222 198.51.100.20:59282 users:(("sshd-session",pid=300,fd=9),("sshd-session",pid=301,fd=9))\n',
  ps: '300 root 7300\n301 adminroot 7290\n',
  passwd: 'root:x:0:0:root:/root:/bin/bash\nadminroot:x:1001:1001::/home/adminroot:/bin/bash\n',
  group: 'docker:x:986:stackroot\nsudo:x:27:adminroot\n',
  sudoers: 'Defaults env_reset\nadminroot ALL=(ALL) NOPASSWD:ALL\ndeployuser ALL=(root) NOPASSWD: /usr/local/sbin/ci-broker-runnerctl\n# ubuntu ALL=(ALL) NOPASSWD:ALL\n',
  persist_items: 'authorized_keys:/root/.ssh/authorized_keys\taaa\nunit:t3.service\tbbb\n',
  proc_exe: '1 /usr/lib/systemd/systemd\n2 /home/deployuser/.nvm/versions/node/v26/bin/node\n3 /tmp/test-binary\n4 /usr/bin/bash (deleted)\n',
  docker_inspect: '/my-vps-usage-server|host|false|||/home/deploy/.usage-server/data \n/my-vps-cli-proxy-api|host|false|||/home/deploy/.cliproxyapi/auths \n/my-vps-cloudflared|host|false|||\n',
  uu_enabled: 'enabled\n',
  auto_upgrades: 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n',
}

type Result = { code: number; out: string; err: string }

describe('host_security.sh', () => {
  let root = ''
  let fix = ''
  let state = ''
  let secd = ''

  const run = (env: Record<string, string> = {}, args: string[] = []): Result => {
    const r = spawnSync('bash', [SCRIPT, ...args], {
      env: {
        PATH: process.env.PATH ?? '',
        SECURITY_STATE_DIR: state, SECURITY_CRON_DIR: join(root, 'cron.d'), STACKS_MANIFEST_DIR: join(root, 'stacks'), SECURITY_NOW: String(NOW),
        ...env,
      },
      encoding: 'utf-8',
      timeout: 30_000,
    })
    return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' }
  }
  const builtin = (env: Record<string, string> = {}, args: string[] = []) =>
    run({ SECURITY_FIXTURE_DIR: fix, SECURITY_DIR: secd, ...env }, args)
  const custom = (env: Record<string, string> = {}, args: string[] = []) =>
    run({ SECURITY_BUILTIN: 'false', SECURITY_DIR: secd, ...env }, args)
  const check = (name: string, body: string, mode = 0o755) => {
    writeFileSync(join(secd, name), `#!/bin/bash\n${body}\n`)
    chmodSync(join(secd, name), mode)
  }
  const fixture = (files: Record<string, string>) => {
    for (const [k, v] of Object.entries(files)) writeFileSync(join(fix, k), v)
  }
  const lines = (out: string) => out.trim().split('\n').filter(Boolean)

  beforeEach(() => {
    root = makeTmpDir('hsec')
    fix = join(root, 'fix'); state = join(root, 'state'); secd = join(root, 'security.d')
    mkdirSync(fix); mkdirSync(secd); mkdirSync(join(root, 'cron.d'))
    fixture(HEALTHY)
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  // --- Custom security.d checks ---------------------------------------------------

  describe('custom security.d checks', () => {
    it('passes well-formed lines through and replaces pipes in the detail', () => {
      check('10-a.sh', 'echo "OK|backups|fresh"\necho "WARN|disk|a|b|c"\necho "INFO|note|plain"')
      const r = custom()
      expect(r.code).toBe(0)
      expect(lines(r.out)).toEqual(['OK|backups|fresh', 'WARN|disk|a/b/c', 'INFO|note|plain'])
    })

    it('runs scripts in sorted order and skips non-executable ones', () => {
      check('20-b.sh', 'echo "OK|b|2"')
      check('10-a.sh', 'echo "OK|a|1"')
      check('30-c.sh', 'echo "OK|c|3"', 0o644)
      expect(lines(custom().out)).toEqual(['OK|a|1', 'OK|b|2', 'INFO|security.d/30-c.sh|not executable; skipped'])
    })

    it('turns malformed output into one WARN', () => {
      check('x.sh', 'echo "hello world"\necho "BAD|x|y"\necho "OK|fine|yes"')
      expect(lines(custom().out)).toEqual([
        'OK|fine|yes',
        'WARN|security.d/x.sh|malformed output (2 line(s) not STATUS|label|detail)'.replace('STATUS|label|detail', 'STATUS/label/detail'),
      ])
    })

    it('reports a non-zero exit but keeps the lines it printed', () => {
      check('x.sh', 'echo "FAIL|thing|broken"; exit 3')
      expect(lines(custom().out)).toEqual(['FAIL|thing|broken', 'WARN|security.d/x.sh|failed (exit 3)'])
    })

    it.skipIf(!HAS_TIMEOUT)('times out a hanging check without aborting the run', () => {
      check('10-slow.sh', 'sleep 5; echo "OK|late|never"')
      check('20-ok.sh', 'echo "OK|after|ran"')
      const t0 = Date.now()
      const r = custom({ SECURITY_CHECK_TIMEOUT: '1' })
      expect(Date.now() - t0).toBeLessThan(4500)
      expect(lines(r.out)).toEqual(['WARN|security.d/10-slow.sh|timed out after 1s', 'OK|after|ran'])
    })

    it('never lets stderr (where secrets may leak) reach stdout', () => {
      check('x.sh', 'echo "TELEGRAM_BOT_TOKEN=123456789:AAbbCCddEEffGGhhIIjjKKllMMnnOOppQQ" >&2\necho "OK|x|fine"')
      const r = custom()
      expect(r.out).not.toContain('123456789')
      expect(r.out).not.toContain('AAbbCC')
      expect(lines(r.out)).toEqual(['OK|x|fine'])
    })

    it('custom can be skipped like a built-in', () => {
      check('x.sh', 'echo "OK|x|fine"')
      expect(custom({ SECURITY_SKIP: 'custom' }).out).toBe('')
    })
  })

  // --- Telegram rendering ---------------------------------------------------------

  describe('--telegram', () => {
    it('escapes HTML, uses emoji, collapses OK lines and ends with ISSUES=<n>', () => {
      check('x.sh', [
        'echo "OK|a|1"', 'echo "OK|b|2"', 'echo "OK|c|3"',
        'echo "WARN|web <b>&|bad & <script>"',
        'echo "FAIL|root|uid 0 > 1"',
        'echo "INFO|note|a & b"',
        'echo "INFO|reachable:ssh|tcp/222 open"',
      ].join('\n'))
      const r = custom({}, ['--telegram'])
      expect(r.code).toBe(0)
      const l = lines(r.out)
      expect(l[0]).toBe('<b>Security:</b>')
      expect(l[1]).toBe('🔴 root: uid 0 &gt; 1') // FAIL first
      expect(l[2]).toBe('⚠️ web &lt;b&gt;&amp;: bad &amp; &lt;script&gt;')
      expect(l).toContain('<i>Reachable from the internet:</i>')
      expect(l).toContain('🌐 ssh: tcp/222 open')
      expect(l).toContain('✅ 3 checks OK')
      expect(l).toContain('ℹ️ note: a &amp; b')
      expect(l[l.length - 1]).toBe('ISSUES=2')
      expect(r.out).not.toMatch(/<(?!\/?[bi]>)/) // only <b> and <i> tags survive
    })

    it('caps lines and says how many were left out; truncates long details', () => {
      const body = Array.from({ length: 40 }, (_, i) => `echo "WARN|w${i}|${'x'.repeat(300)}"`).join('\n')
      check('x.sh', body)
      const l = lines(custom({}, ['--telegram']).out)
      expect(l.length).toBeLessThanOrEqual(25 + 2)
      expect(l[l.length - 1]).toBe('ISSUES=40')
      expect(l[l.length - 2]).toMatch(/^… \+\d+ more \(see logs\/host_security\.log\)$/)
      expect(l[1].length).toBeLessThan(200)
      expect(l[1].endsWith('…')).toBe(true)
    })

    it('limits INFO lines and drops INFO before reach and problem lines when over budget', () => {
      const body = [
        ...Array.from({ length: 20 }, (_, i) => `echo "INFO|i${i}|${'y'.repeat(100)}"`),
        'echo "WARN|keep|me"',
        'echo "INFO|reachable:tunnel|a.example.com → http://localhost:1"',
      ].join('\n')
      check('x.sh', body)
      const full = lines(custom({}, ['--telegram']).out)
      expect(full.filter(x => x.startsWith('ℹ️')).length).toBe(8)
      const tight = custom({ SECURITY_TELEGRAM_BUDGET: '400' }, ['--telegram']).out
      expect(Buffer.byteLength(tight.replace(/\nISSUES=\d+\n$/, ''))).toBeLessThanOrEqual(400)
      expect(tight).toContain('⚠️ keep: me')
      expect(tight).toContain('🌐 tunnel: a.example.com')
      expect(tight).toMatch(/ISSUES=1\n$/)
    })

    it('writes the raw lines to INSTALL_DIR/logs/host_security.log', () => {
      mkdirSync(join(root, 'logs'))
      check('x.sh', 'echo "OK|x|fine"')
      custom({ INSTALL_DIR: root }, ['--telegram'])
      const log = readFileSync(join(root, 'logs', 'host_security.log'), 'utf-8')
      expect(log).toMatch(/^=== .* host_security ===\nOK\|x\|fine\n$/)
    })
  })

  // --- Knobs ----------------------------------------------------------------------

  it('rejects bad knob values with exit 2 and a clear message', () => {
    expect(custom({ SECURITY_CHECK_TIMEOUT: 'soon' })).toMatchObject({ code: 2 })
    expect(custom({ SECURITY_CHECK_TIMEOUT: 'soon' }).err).toContain('SECURITY_CHECK_TIMEOUT must be a whole number')
    expect(custom({ SECURITY_SSH_FAIL_WARN: '-1' }).code).toBe(2)
    expect(custom({ SECURITY_BUILTIN: 'maybe' }).err).toContain('SECURITY_BUILTIN must be true or false')
    expect(custom({ SECURITY_SKIP: 'firewall sssh' }).err).toContain("unknown check 'sssh'")
    expect(custom({ SECURITY_PUBLIC_PORTS: 'ssh' }).err).toContain('SECURITY_PUBLIC_PORTS')
    expect(custom({ SECURITY_OUTBOUND_OK_PORTS: '443 https' }).code).toBe(2)
    expect(custom({}, ['--bogus']).code).toBe(2)
  })

  it('--help prints usage and exits 0', () => {
    const r = custom({}, ['--help'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('--telegram')
    expect(r.out).toContain('SECURITY_SKIP')
  })

  // --- Built-ins on fixtures --------------------------------------------------------

  describe('built-in checks (fixtures from a healthy testbox)', () => {
    it('a healthy box has no WARN/FAIL and every line follows the protocol', () => {
      const r = builtin()
      expect(r.code).toBe(0)
      for (const l of lines(r.out)) expect(l).toMatch(LINE)
      expect(r.out).not.toMatch(/^(WARN|FAIL)/m)
      expect(r.out).toContain('OK|firewall|ufw active, default deny incoming, INPUT policy DROP')
      expect(r.out).toContain('OK|tailscale:netfilter|nodivert')
      expect(r.out).toContain('INFO|tailscale|Running; tags: tag:cliproxy,tag:server')
      expect(r.out).toContain('INFO|reachable:ssh|tcp/222 open to the internet; key-only, root login off')
      expect(r.out).toContain('INFO|reachable:public|also open (expected): udp/41641')
      expect(r.out).toContain('INFO|reachable:listeners|on all interfaces, UFW blocks public: tcp/8317, tcp/20241')
      expect(r.out).toContain('INFO|reachable:tailnet|not public: UFW on tailscale0 tcp/3773, tcp/8317; serve tcp/3773 → 127.0.0.1:3773')
      expect(r.out).toContain('INFO|reachable:tunnel|cliproxy.example.com → http://localhost:8317 (4 connections)')
      expect(r.out).not.toContain('old.example.com') // only the latest config line counts
      expect(r.out).toContain('OK|cloudflared|tunnel ready, 4 connections')
      expect(r.out).toContain('INFO|docker|host network (sees all host interfaces): my-vps-usage-server, my-vps-cli-proxy-api, my-vps-cloudflared')
      expect(r.out).toContain('INFO|ssh:sessions|1 open: adminroot from 198.51.100.20 (public, 2h01m)')
      expect(r.out).toContain('INFO|ssh:logins|24 h: adminroot from 198.51.100.20 (public) 00:14–07:45, key "laptop key"')
      expect(r.out).toContain('INFO|accounts:sudo|NOPASSWD sudo: adminroot (ALL), deployuser (limited)')
      expect(r.out).toContain('INFO|persistence|baseline created')
      expect(r.out).toContain('OK|processes|')
      expect(r.out).toContain('OK|updates|unattended-upgrades enabled')
    })

    it('the jq-free JSON fallback reads tailscale tags and serve forwards the same way', () => {
      const r = builtin({ SECURITY_NO_JQ: 'true' })
      expect(r.out).toContain('INFO|tailscale|Running; tags: tag:cliproxy,tag:server')
      expect(r.out).toContain('serve tcp/3773 → 127.0.0.1:3773')
    })

    it('FAILs when tailscale diverts tailnet traffic around UFW', () => {
      fixture({ iptables_ts: '', 'iptables_ts.rc': '0' })
      expect(builtin().out).toContain('FAIL|tailscale:netfilter|tailscale default netfilter mode: all tailnet traffic bypasses UFW; run `tailscale set --netfilter-mode=nodivert`')
    })

    it('FAILs on an inactive or allow-by-default firewall', () => {
      fixture({ ufw_status: 'Status: inactive\n' })
      expect(builtin({ SECURITY_SKIP: 'reachability' }).out).toContain('FAIL|firewall|ufw is not active')
      fixture({ ufw_status: HEALTHY.ufw_status.replace('deny (incoming)', 'allow (incoming)') })
      expect(builtin().out).toContain("FAIL|firewall|ufw default incoming policy is 'allow'")
    })

    it('WARNs on an unexpected public port, saying whether something listens behind it', () => {
      fixture({
        ufw_status: HEALTHY.ufw_status + '8080/tcp                   ALLOW IN    Anywhere\n9000                       ALLOW IN    Anywhere\n',
        ss_listen: HEALTHY.ss_listen + 'LISTEN 0 4096 0.0.0.0:8080 0.0.0.0:*\n',
      })
      const out = builtin().out
      expect(out).toContain('WARN|reachable:unexpected|tcp/8080 is open to the internet (UFW allows it, wildcard listener)')
      expect(out).toContain('WARN|reachable:unexpected|9000 (tcp+udp) is allowed by UFW from anywhere (nothing listens now)')
      expect(out).not.toContain('tcp/8080, ') // not also listed as "blocked"
    })

    it('udp wildcard listeners and tailnet-bound sockets never WARN', () => {
      fixture({ ss_listen: HEALTHY.ss_listen + 'UNCONN 0 0 *:52497 *:*\nLISTEN 0 4096 100.100.1.1:5555 0.0.0.0:*\n' })
      expect(builtin().out).not.toMatch(/^(WARN|FAIL)/m)
    })

    it('flags Docker ports published on all addresses once per port, and risky container settings', () => {
      fixture({ docker_inspect: '/web|bridge|true|host|80/tcp@0.0.0.0:8080 80/tcp@:::8080 |/var/run/docker.sock \n/ok|bridge|false||80/tcp@127.0.0.1:8081 |\n' })
      const out = builtin().out
      expect(out.match(/reachable:docker/g)).toHaveLength(1)
      expect(out).toContain('WARN|reachable:docker|tcp/8080 is open to the internet: published by container web on all addresses (Docker bypasses UFW)')
      expect(out).toContain('WARN|docker|web runs --privileged')
      expect(out).toContain('WARN|docker|web uses the host PID namespace')
      expect(out).toContain('WARN|docker|web mounts the Docker socket (root-equivalent)')
    })

    it('SECURITY_HOSTNET_OK silences the host-network INFO', () => {
      expect(builtin({ SECURITY_HOSTNET_OK: 'my-vps-*' }).out).not.toContain('host network')
    })

    it('cloudflared: 0 connections FAIL, below minimum WARN, no metrics INFO', () => {
      fixture({ cloudflared_ready: '{"status":503,"readyConnections":0}' })
      expect(builtin().out).toContain('FAIL|cloudflared|tunnel has 0 ready connections')
      fixture({ cloudflared_ready: '{"status":200,"readyConnections":1}' })
      expect(builtin().out).toContain('WARN|cloudflared|tunnel has only 1 ready connection(s) (minimum 2)')
      fixture({ cloudflared_ready: '' })
      expect(builtin().out).toContain('INFO|cloudflared|not running / no metrics on 127.0.0.1:20241')
    })

    it('tunnel hostnames: expected/unexpected lists, static fallback, unknown', () => {
      let out = builtin({ SECURITY_EXPECT_DOMAINS: 'api.example.com cliproxy.example.com' }).out
      expect(out).toContain('WARN|reachable:tunnel|expected hostname api.example.com is not in the tunnel config')
      out = builtin({ SECURITY_EXPECT_DOMAINS: 'api.example.com' }).out
      expect(out).toContain('WARN|reachable:tunnel|unexpected tunnel hostname cliproxy.example.com')
      fixture({ cloudflared_logs: 'nothing useful\n' })
      expect(builtin().out).toContain('INFO|reachable:tunnel|tunnel hostnames unknown (not in recent logs) (4 connections)')
      expect(builtin({ SECURITY_TUNNEL_DOMAINS: 'a.example.com' }).out).toContain('INFO|reachable:tunnel|a.example.com (from SECURITY_TUNNEL_DOMAINS) (4 connections)')
    })

    it('ssh: bad config FAILs; failed-login pressure WARNs above the threshold', () => {
      fixture({
        sshd_T: 'port 22\npermitrootlogin yes\npasswordauthentication yes\n',
        journal_ssh: Array.from({ length: 5 }, (_, i) => `Nov 25 x sshd[1]: Invalid user u${i} from 203.0.113.${i % 2} port ${1000 + i}`).join('\n') + '\n',
      })
      const out = builtin({ SECURITY_SSH_FAIL_WARN: '3' }).out
      expect(out).toContain("FAIL|ssh|PermitRootLogin is 'yes'")
      expect(out).toContain('FAIL|ssh|PasswordAuthentication is yes')
      expect(out).toContain('WARN|ssh:failures|5 failed login(s) from 2 IP(s) in 24 h (threshold 3)')
      expect(out).toContain('INFO|ssh:failures|top sources: 203.0.113.0 ×3 (public), 203.0.113.1 ×2 (public); users tried: u0, u1, u2, u3, u4')
      expect(out).toContain('INFO|reachable:ssh|sshd (tcp/22) is not open to the internet by UFW; PASSWORDS ALLOWED, root login yes')
    })

    it('ssh logins: one entry per user+source+key with a time window and the key comment, no counts', () => {
      fixture({
        journal_ssh: [
          'Nov 25 09:00:01 h sshd-session[1]: Accepted publickey for adminroot from 198.51.100.20 port 1 ssh2: ED25519 SHA256:x',
          ...Array.from({ length: 300 }, (_, i) => `Nov 25 09:${String(10 + Math.floor(i / 8)).padStart(2, '0')}:00 h sshd-session[2]: Accepted publickey for adminroot from 198.51.100.20 port ${2 + i} ssh2: ED25519 SHA256:x`),
          'Nov 25 10:30:00 h sshd-session[3]: Accepted publickey for adminroot from 198.51.100.30 port 9 ssh2: ED25519 SHA256:removedkey123',
          'Nov 25 11:00:00 h sshd-session[4]: Accepted publickey for deployuser from 192.168.1.5 port 9 ssh2: ED25519 SHA256:abcdefghijklmnop',
        ].join('\n') + '\n',
      })
      const line = builtin().out.split('\n').find((l) => l.startsWith('INFO|ssh:logins|'))!
      expect(line).not.toMatch(/×\d/)
      expect(line).toContain('deployuser from 192.168.1.5 (private) at 11:00, key …ijklmnop') // no readable keys for deployuser
      expect(line).toContain('adminroot from 198.51.100.30 (public) at 10:30, key …edkey123 (NOT in authorized_keys now)')
      expect(line).toContain('adminroot from 198.51.100.20 (public) 09:00–09:47, key "laptop key"')
      expect(line.indexOf('deployuser')).toBeLessThan(line.indexOf('198.51.100.20')) // newest first
    })

    it('ssh failures: several log lines of one attempt count once', () => {
      fixture({
        journal_ssh: [
          'Nov 25 x sshd[1]: Invalid user admin from 203.0.113.5 port 4242',
          'Nov 25 x sshd[1]: Failed password for invalid user admin from 203.0.113.5 port 4242 ssh2',
          'Nov 25 x sshd[1]: Connection closed by invalid user admin 203.0.113.5 port 4242 [preauth]',
          'Nov 25 x sshd[2]: Connection closed by authenticating user root 203.0.113.6 port 5000 [preauth]',
        ].join('\n') + '\n',
      })
      const out = builtin().out
      expect(out).toContain('OK|ssh:failures|2 failed login(s) from 2 IP(s) in 24 h')
      expect(out).toMatch(/INFO\|ssh:failures\|top sources: 203\.0\.113\.5 ×1 \(public\), 203\.0\.113\.6 ×1 \(public\); users tried: admin, root/)
    })

    it('ssh sources: learning first, then WARN once for a new IP', () => {
      builtin() // creates the baseline (learning)
      const later = String(NOW + 5 * DAY)
      fixture({ journal_ssh: HEALTHY.journal_ssh + 'Nov 30 x sshd-session[3]: Accepted publickey for adminroot from 198.51.100.7 port 4 ssh2\n' })
      const out = builtin({ SECURITY_NOW: later }).out
      expect(out).toContain('WARN|ssh:new-source|first SSH login from 198.51.100.7 (public) as adminroot')
      expect(builtin({ SECURITY_NOW: later }).out).not.toContain('ssh:new-source')
    })

    it('accounts: extra uid 0 FAILs; docker group mismatch WARNs', () => {
      fixture({ passwd: HEALTHY.passwd + 'toor:x:0:0::/root:/bin/sh\n' })
      const out = builtin({ SECURITY_DOCKER_USERS: 'stackroot deployuser' }).out
      expect(out).toContain('FAIL|accounts|uid 0 accounts besides root: toor')
      expect(out).toContain("WARN|accounts:docker|docker group is 'stackroot', expected 'deployuser stackroot'")
      expect(builtin({ SECURITY_DOCKER_USERS: 'stackroot' }).out).toContain('OK|accounts:docker|docker group = stackroot')
    })

    it('persistence: baseline, then one WARN naming changed items, then quiet', () => {
      expect(builtin().out).toContain('INFO|persistence|baseline created (2 items')
      expect(builtin().out).toContain('OK|persistence|2 items unchanged')
      fixture({ persist_items: 'authorized_keys:/root/.ssh/authorized_keys\tCHANGED\nunit:evil.service\tx\n' })
      const out = builtin().out
      expect(out).toContain('WARN|persistence|since last run: added: unit:evil.service; changed: authorized_keys:/root/.ssh/authorized_keys; removed: unit:t3.service')
      expect(out).not.toContain('CHANGED') // names only, never contents or hashes
      expect(builtin().out).toContain('OK|persistence|2 items unchanged')
    })

    it('secrets: token-shaped string in cron.d FAILs naming only the file; loose modes WARN', () => {
      writeFileSync(join(root, 'cron.d', 'leaky'), '* * * * * root TELEGRAM_BOT_TOKEN=123456789:AAbbCCddEEffGGhhIIjjKKllMMnnOOppQQ x.sh\n')
      const inst = join(root, 'inst')
      mkdirSync(join(inst, 'crons', 'env.d'), { recursive: true })
      chmodSync(inst, 0o755)
      writeFileSync(join(inst, 'crons', 'env.d', 'a.env'), 'X=1\n', { mode: 0o644 })
      chmodSync(join(inst, 'crons', 'env.d', 'a.env'), 0o644)
      const out = builtin({ INSTALL_DIR: inst }).out
      expect(out).toContain(`FAIL|secrets|Telegram-token-shaped string in world-readable ${join(root, 'cron.d', 'leaky')}`)
      expect(out).not.toContain('123456789')
      expect(out).toContain(`WARN|secrets|${inst} is world-readable (mode 755)`)
      expect(out).toContain('WARN|secrets|cron env files not mode 600: a.env (644)')
      expect(out).toMatch(/WARN\|secrets\|world-readable secret-like files in an install dir other users can enter: .*a\.env/)
      chmodSync(inst, 0o750) // others cannot enter: world-readable files inside are not exposed
      expect(builtin({ INSTALL_DIR: inst }).out).not.toContain('secret-like files')
    })

    it('processes: flags /dev/shm, /var/tmp and hidden system dirs, not /tmp or home dot-dirs', () => {
      fixture({ proc_exe: HEALTHY.proc_exe + '9 /dev/shm/x (deleted)\n10 /var/tmp/y\n11 /tmp/.X11/z\n' })
      const out = builtin().out
      expect(out).toContain('WARN|processes|running from /dev/shm, /var/tmp or a hidden dir: pid 9 /dev/shm/x; pid 10 /var/tmp/y; pid 11 /tmp/.X11/z')
      expect(builtin({ SECURITY_EXE_OK: '/dev/shm/* /var/tmp/* /tmp/.X11/*' }).out).toContain('OK|processes|')
    })

    it('SECURITY_SKIP removes checks; SECURITY_BUILTIN=false removes all', () => {
      const out = builtin({ SECURITY_SKIP: 'firewall tailscale reachability' }).out
      expect(out).not.toMatch(/\|(firewall|tailscale|reachable:ssh)\|/)
      expect(builtin({ SECURITY_BUILTIN: 'false' }).out).toBe('')
    })
  })

  // --- Outbound sampler -------------------------------------------------------------

  describe('outbound tracking (--sample + daily report)', () => {
    const seen = () => readFileSync(join(state, 'conn-seen'), 'utf-8')

    it('--sample records public outbound destinations only, deduped, and is silent', () => {
      const r = builtin({}, ['--sample'])
      expect(r.code).toBe(0)
      expect(r.out).toBe('')
      expect(seen()).toBe(`#created=${NOW}\nCLIProxyAPI|2001:db8:ffff::10|443|${NOW}|${NOW}\nnode-MainThread|192.0.2.50|443|${NOW}|${NOW}\n`)
      builtin({ SECURITY_NOW: String(NOW + 60) }, ['--sample'])
      expect(seen()).toContain(`node-MainThread|192.0.2.50|443|${NOW}|${NOW + 60}`) // first kept, last updated
      expect(seen().split('\n').filter(Boolean)).toHaveLength(3)
    })

    it('forgets destinations not seen for SECURITY_CONN_KEEP_DAYS and caps the file', () => {
      mkdirSync(state)
      writeFileSync(join(state, 'conn-seen'), `#created=${NOW - 200 * DAY}\nold|1.1.1.1|443|${NOW - 100 * DAY}|${NOW - 91 * DAY}\nrecent|192.0.2.22|443|${NOW - 100 * DAY}|${NOW - DAY}\n`)
      builtin({}, ['--sample'])
      expect(seen()).not.toContain('old|')
      expect(seen()).toContain('recent|')
      builtin({ SECURITY_CONN_MAX: '1' }, ['--sample'])
      expect(seen().split('\n').filter(Boolean)).toHaveLength(2) // header + 1
    })

    it('--sample never fails loudly (no ss, unwritable state)', () => {
      rmSync(join(fix, 'ss_est'))
      expect(builtin({}, ['--sample'])).toMatchObject({ code: 0, out: '', err: '' })
      expect(builtin({ SECURITY_STATE_DIR: '/nonexistent/x' }, ['--sample'])).toMatchObject({ code: 0, out: '' })
    })

    it('learning period: new destinations are INFO only', () => {
      fixture({ ss_est: HEALTHY.ss_est + '0 0 203.0.113.10:40150 203.0.113.9:4444 users:(("nc",pid=9,fd=3))\n' })
      const out = builtin().out
      expect(out).toContain('INFO|outbound|learning baseline (day 1 of 3): 3 new destination(s) in 24 h, 3 known')
      expect(out).not.toContain('WARN|outbound')
    })

    it('after learning: WARN for a new process or unusual port; known process on 443 is only counted', () => {
      builtin({}, ['--sample'])
      const later = String(NOW + 4 * DAY)
      fixture({
        ss_est: HEALTHY.ss_est
          + '0 0 203.0.113.10:40150 203.0.113.9:4444 users:(("nc",pid=9,fd=3))\n'
          + '0 0 203.0.113.10:40151 192.0.2.99:443 users:(("node-MainThread",pid=16076,fd=3))\n'
          + '0 0 203.0.113.10:40152 192.0.2.98:6667 users:(("CLIProxyAPI",pid=2281,fd=3))\n',
      })
      const out = builtin({ SECURITY_NOW: later }).out
      expect(out).toContain('WARN|outbound:new|nc (new process) → 203.0.113.9:4444')
      expect(out).toContain('WARN|outbound:new|CLIProxyAPI (unusual port) → 192.0.2.98:6667')
      expect(out).toContain('INFO|outbound|1 new IP(s) on usual ports from known processes in 24 h')
      const quiet = builtin({ SECURITY_NOW: later, SECURITY_KNOWN_PROCS: 'nc', SECURITY_KNOWN_REMOTES: '192.0.2.98:6667 203.0.113.9' }).out
      expect(quiet).not.toContain('WARN|outbound')
    })
  })

  // --- host_alerter.sh wiring ---------------------------------------------------------

  describe('host_alerter.sh security section', () => {
    it('has valid bash syntax', () => {
      expect(() => execFileSync('bash', ['-n', ALERTER])).not.toThrow()
      expect(() => execFileSync('bash', ['-n', SCRIPT])).not.toThrow()
    })

    // Runs only the marked security_section block of the alerter (the rest needs Linux /proc, docker, Telegram).
    const section = (fake: string | null): { section: string; issues: string } => {
      const src = readFileSync(ALERTER, 'utf-8')
      const block = src.slice(src.indexOf('# >>> security-section'), src.indexOf('# <<< security-section'))
      expect(block.length).toBeGreaterThan(100)
      writeFileSync(join(root, 'block.sh'), block)
      if (fake !== null) writeFileSync(join(root, 'fake.sh'), fake)
      const out = execFileSync('bash', ['-c', `set -euo pipefail; source "${join(root, 'block.sh')}"; security_section 800; printf '%s\\n---\\n%s' "$SECURITY_SECTION" "$SECURITY_ISSUES"`], {
        env: { PATH: process.env.PATH ?? '', INSTALL_DIR: root, SECURITY_SCRIPT: join(root, 'fake.sh') },
        encoding: 'utf-8',
      })
      const [s, i] = out.split('\n---\n')
      return { section: s, issues: i }
    }

    it('appends the section without the ISSUES line and returns the count', () => {
      expect(section('echo "<b>Security:</b>"; echo "⚠️ x: y"; echo "budget=$SECURITY_TELEGRAM_BUDGET"; echo ISSUES=2'))
        .toEqual({ section: '<b>Security:</b>\n⚠️ x: y\nbudget=2950', issues: '2' })
    })

    it('a crash, a missing ISSUES line or a missing script becomes one failed-to-run issue', () => {
      const failed = { section: '⚠️ Security checks failed to run', issues: '1' }
      expect(section('echo "<b>Security:</b>"; exit 1')).toEqual(failed)
      expect(section('echo "<b>Security:</b>"')).toEqual(failed)
      rmSync(join(root, 'fake.sh'))
      expect(existsSync(join(root, 'fake.sh'))).toBe(false)
      expect(section(null)).toEqual(failed)
    })

    it('runs the real host_security.sh end to end through the alerter block', () => {
      const real = readFileSync(SCRIPT, 'utf-8')
      check('x.sh', 'echo "WARN|thing|a & b"')
      const r = section(`export SECURITY_BUILTIN=false SECURITY_DIR="${secd}"\n${real}`)
      expect(r).toEqual({ section: '<b>Security:</b>\n⚠️ thing: a &amp; b', issues: '1' })
    })

    it('the 15-minute run samples outbound connections on exit, best effort', () => {
      const src = readFileSync(ALERTER, 'utf-8')
      expect(src).toContain("trap 'security_sample' EXIT")
      expect(src.indexOf("trap 'security_sample' EXIT")).toBeGreaterThan(src.indexOf('# --- Normal alert mode'))
    })
  })
})

// Linux only: the real built-ins against this machine (no fixtures). Privileged checks are skipped,
// so this proves the script degrades cleanly without root and keeps the protocol.
describe.skipIf(process.platform !== 'linux')('host_security.sh built-ins on a real Linux host', () => {
  it('exits 0 quickly and every line follows the protocol', () => {
    const root = makeTmpDir('hsec-live')
    try {
      const t0 = Date.now()
      const r = spawnSync('bash', [SCRIPT], {
        env: { PATH: process.env.PATH ?? '', SECURITY_STATE_DIR: join(root, 'state'), SECURITY_SKIP: 'firewall ssh sshsources docker' },
        encoding: 'utf-8', timeout: 60_000,
      })
      expect(r.status).toBe(0)
      expect(Date.now() - t0).toBeLessThan(30_000)
      for (const l of (r.stdout ?? '').trim().split('\n').filter(Boolean)) expect(l).toMatch(LINE)
      const tg = spawnSync('bash', [SCRIPT, '--telegram'], {
        env: { PATH: process.env.PATH ?? '', SECURITY_STATE_DIR: join(root, 'state'), SECURITY_SKIP: 'firewall ssh sshsources docker' },
        encoding: 'utf-8', timeout: 60_000,
      })
      expect(tg.status).toBe(0)
      expect(tg.stdout).toMatch(/^<b>Security:<\/b>\n[\s\S]*\nISSUES=\d+\n$/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
