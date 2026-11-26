import { describe, it, expect } from 'vitest'
import { redact, isRedactionClean, shortHash, withLineNumbers } from '../../../../cli/lib/redact/index'

// Fake tokens are built by concatenation so the repo leak scan stays clean.
const FAKE_SK = 'sk' + '-' + 'testFAKE0123456789abcdefXYZ'
const FAKE_GH = 'gh' + 'p_' + 'A'.repeat(36)
const FAKE_TG = '123456789' + ':' + 'AAF' + 'x'.repeat(32)

const m = (label: string, value: string) => `[redacted:${label}:${shortHash(value)}]`

describe('layer 1: known secret values', () => {
  it('replaces every occurrence and names the secret', () => {
    const r = redact('a: hunter2pass\nb: "hunter2pass"\n', { secrets: { DB_PASSWORD: 'hunter2pass' } })
    expect(r.text).toBe(`a: ${m('DB_PASSWORD', 'hunter2pass')}\nb: "${m('DB_PASSWORD', 'hunter2pass')}"\n`)
    expect(r.hits).toEqual([
      { line: 1, kind: 'secret', label: 'DB_PASSWORD' },
      { line: 2, kind: 'secret', label: 'DB_PASSWORD' },
    ])
  })

  it('handles regex special characters in values', () => {
    const v = 'a.b*c+(d)[e]$^|\\x'
    const r = redact(`x ${v} y`, { secrets: { S: v } })
    expect(r.text).toBe(`x ${m('S', v)} y`)
  })

  it('replaces the longest value first when one value holds another', () => {
    const r = redact('long=abcdef123456 short=abcdef', { secrets: { SHORT: 'abcdef', LONG: 'abcdef123456' } })
    expect(r.text).toBe(`long=${m('LONG', 'abcdef123456')} short=${m('SHORT', 'abcdef')}`)
  })

  it('ignores short, boolean and small numeric values', () => {
    const text = 'port 8080 flag true id abc'
    const r = redact(text, { secrets: { A: 'abc', B: 'true', C: '8080' } })
    expect(r.text).toBe(text)
    expect(r.count).toBe(0)
  })

  it('gives the same marker for the same value', () => {
    const a = redact('k: s3cretvalue', { secrets: { K: 's3cretvalue' } }).text
    const b = redact('other k: s3cretvalue', { secrets: { K: 's3cretvalue' } }).text
    expect(a.slice(3)).toBe(b.slice(9))
  })
})

describe('layer 3a: secret-ish key names', () => {
  it('redacts YAML, env, export and JSON forms', () => {
    const text = [
      'password: opensesame99',
      'API_TOKEN=tok_value_1234',
      'export API_TOKEN="tok_value_1234"',
      '{"apiKey": "abc-def-ghi", "name": "demo"}',
    ].join('\n')
    const r = redact(text)
    expect(r.text.split('\n')).toEqual([
      `password: ${m('password', 'opensesame99')}`,
      `API_TOKEN=${m('API_TOKEN', 'tok_value_1234')}`,
      `export API_TOKEN="${m('API_TOKEN', 'tok_value_1234')}"`,
      `{"apiKey": "${m('apiKey', 'abc-def-ghi')}", "name": "demo"}`,
    ])
    expect(r.hits.map(h => h.kind)).toEqual(['key', 'key', 'key', 'key'])
  })

  it('redacts commented-out lines', () => {
    const r = redact('# secret-key: abcdef12345\n// "token": "zzzzzz9"')
    expect(r.text).toBe(`# secret-key: ${m('secret-key', 'abcdef12345')}\n// "token": "${m('token', 'zzzzzz9')}"`)
  })

  it('leaves references, placeholders and trivial values alone', () => {
    const text = [
      'password: ${DB_PASSWORD}',
      'token: "{{ secrets.token }}"',
      'api_key: <your-key-here>',
      'secret:',
      'session: null',
      'cookie: ~',
      'pass: true',
      'auth_key: ""',
      'max_tokens: 4096',
      'token_url: https://auth.example.com/token',
      'password_file: /run/secrets/db',
    ].join('\n')
    expect(redact(text).text).toBe(text)
    expect(isRedactionClean(text)).toBe(true)
  })

  it('redacts list items under a secret-ish key', () => {
    const r = redact('api-keys:\n  - first-key-1\n  - "second-key-2"\nport: 8317')
    expect(r.text).toBe(`api-keys:\n  - ${m('api-keys', 'first-key-1')}\n  - "${m('api-keys', 'second-key-2')}"\nport: 8317`)
  })

  it('redacts a block scalar body and keeps the line count', () => {
    const text = 'private_key: |\n  line-one\n  line-two\nnext: 1'
    const r = redact(text)
    expect(r.text).toBe(`private_key: |\n  ${m('private_key', 'line-one\nline-two')}\n  \nnext: 1`)
    expect(r.text.split('\n')).toHaveLength(4)
  })
})

describe('layer 3b: value shapes', () => {
  it('redacts known token shapes anywhere', () => {
    const r = redact(`curl -H "Authorization: Bearer ${FAKE_SK}"\nremote ${FAKE_GH}\nbot ${FAKE_TG}`)
    expect(r.text).toContain(m('api-key', FAKE_SK))
    expect(r.text).toContain(m('github-token', FAKE_GH))
    expect(r.text).toContain(m('telegram-bot-token', FAKE_TG))
    expect(r.text).not.toContain(FAKE_SK)
  })

  it('redacts JWT, AWS, Slack, Tailscale and tunnel tokens', () => {
    const jwt = 'eyJ' + 'hbGciOiJIUzI1NiJ9' + '.eyJ' + 'zdWIiOiIxMjM0In0' + '.abcdefghij'
    const aws = 'AKIA' + 'ABCDEFGHIJKLMNOP'
    const slack = 'xox' + 'b-1234-abcdefghij'
    const ts = 'tskey' + '-auth-kFAKE1234CNTRL'
    const cf = 'eyJh' + 'IjoiZmFrZSIsInQiOiJmYWtlIiwicyI6ImZha2UifQ' + 'AAAAAAAAAAAA'
    const r = redact([jwt, aws, slack, ts, cf].join('\n'))
    expect(r.hits.map(h => h.label)).toEqual(['jwt', 'aws-access-key', 'slack-token', 'tailscale-key', 'cloudflare-tunnel-token'])
  })

  it('replaces the body of a PEM private key block', () => {
    const body = 'MIIEFAKEFAKEFAKE\nQUJDREVGR0hJSktM'
    const text = `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\nafter`
    const r = redact(text)
    expect(r.text).toBe(`-----BEGIN PRIVATE KEY-----\n${m('private-key', body)}\n\n-----END PRIVATE KEY-----\nafter`)
    expect(r.hits).toEqual([{ line: 1, kind: 'shape', label: 'private-key' }])
  })

  it('redacts the password in a URL', () => {
    const r = redact('proxy-url: socks5://user:pw-FAKE-123@proxy.example.com:1080/')
    expect(r.text).toBe(`proxy-url: socks5://user:${m('url-password', 'pw-FAKE-123')}@proxy.example.com:1080/`)
  })

  it('redacts long hex and base64 strings only after a key', () => {
    const hex = 'a1b2c3d4'.repeat(5)
    const b64 = 'QWxhZGRpbjpvcGVuIHNlc2FtZQ9xYz' + 'AbCdEfGh1234'
    const r = redact(`signing: ${hex}\nvalue: ${b64}\n${hex}`)
    expect(r.text).toBe(`signing: ${m('hex-secret', hex)}\nvalue: ${m('base64-secret', b64)}\n${hex}`)
  })
})

describe('no false positives on ordinary config', () => {
  it('keeps ports, hosts, paths, image tags and digests', () => {
    const digest = 'sha256:' + 'ab12'.repeat(16)
    const text = [
      'port: 8317',
      'host: 192.0.2.10',
      'domain: app.example.com',
      'path: /home/deploy/.cliproxyapi/config.yaml',
      'image: ghcr.io/example/proxy:1.2.3',
      `pinned: ghcr.io/example/proxy@${digest}`,
      `digest: ${digest}`,
      `commit: ${'0123456789abcdef'.repeat(2)}abcdef01`,
      'transcriptsDir: /home/deployuser/.claude/projects',
      'memory: 1G',
      'enabled: true',
      '- name: cli-proxy-api',
      'url: http://localhost:8317/v1',
    ].join('\n')
    const r = redact(text)
    expect(r.hits).toEqual([])
    expect(r.text).toBe(text)
  })
})

describe('withLineNumbers', () => {
  it('numbers lines like cat -n', () => {
    expect(withLineNumbers('a\nb\n')).toBe('     1\ta\n     2\tb\n')
    expect(withLineNumbers('x')).toBe('     1\tx')
    expect(withLineNumbers('')).toBe('')
  })
})
