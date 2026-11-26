import { describe, it, expect } from 'vitest'
import yaml from 'js-yaml'
import { redact, shortHash, type RedactRule } from '../../../../cli/lib/redact/index'
import { globToRegExp } from '../../../../cli/lib/redact/rules'
import { register } from '../../../../cli/plugins/cliproxyapi/index'

const m = (label: string, value: string) => `[redacted:${label}:${shortHash(value)}]`

describe('globToRegExp', () => {
  it('matches * inside one segment and ** across segments', () => {
    expect(globToRegExp('*.yaml').test('config.yaml')).toBe(true)
    expect(globToRegExp('*.yaml').test('a/config.yaml')).toBe(false)
    expect(globToRegExp('**/config.yaml').test('config.yaml')).toBe(true)
    expect(globToRegExp('**/config.yaml').test('a/b/config.yaml')).toBe(true)
    expect(globToRegExp('a/**').test('a/b/c')).toBe(true)
  })
})

describe('layer 2: plugin rules', () => {
  const rules: RedactRule[] = [{ files: ['conf/*.yaml'], keys: ['upstream', 'remote.code'] }]

  it('applies only to matching files', () => {
    const text = 'upstream: plainvalue1\n'
    expect(redact(text, { rules, file: 'conf/app.yaml' }).text).toBe(`upstream: ${m('upstream', 'plainvalue1')}\n`)
    expect(redact(text, { rules, file: 'other.yaml' }).text).toBe(text)
    expect(redact(text, { rules }).text).toBe(text)
  })

  it('matches dotted paths and not the same key elsewhere', () => {
    const text = 'remote:\n  code: abc123\nlocal:\n  code: def456'
    const r = redact(text, { rules, file: './conf/app.yaml' })
    expect(r.text).toBe(`remote:\n  code: ${m('code', 'abc123')}\nlocal:\n  code: def456`)
    expect(r.hits).toEqual([{ line: 2, kind: 'rule', label: 'code' }])
  })

  it('covers list items and nested mappings under the key', () => {
    const text = [
      'upstream:',
      '  - one-value',
      '  - host: a.example.com',
      '    weight: 5',
      'other: keep',
    ].join('\n')
    const r = redact(text, { rules, file: 'conf/x.yaml' })
    expect(r.text.split('\n')).toEqual([
      'upstream:',
      `  - ${m('upstream', 'one-value')}`,
      `  - host: ${m('host', 'a.example.com')}`,
      `    weight: ${m('weight', '5')}`,
      'other: keep',
    ])
  })

  it('covers flow lists and commented lines, and keeps ${VAR}', () => {
    const text = 'upstream: [aaa111, "bbb222"]\n# upstream: ccc333\nupstream: ${UPSTREAM}'
    const r = redact(text, { rules, file: 'conf/x.yaml' })
    expect(r.text).toBe(
      `upstream: [${m('upstream', 'aaa111')}, "${m('upstream', 'bbb222')}"]\n` +
      `# upstream: ${m('upstream', 'ccc333')}\nupstream: \${UPSTREAM}`,
    )
  })
})

describe('cliproxyapi rule', () => {
  const plugin = register({})
  const text = [
    'port: 8317',
    'remote-management:',
    '  allow-remote: false',
    '  secret-key: "mgmt-FAKE-1"',
    'api-keys:',
    '  - "client-FAKE-1"',
    '  # - "client-FAKE-old"',
    'gemini-api-key:',
    '  - api-key: "gem-FAKE-1"',
    '    base-url: "https://example.com"',
    'openai-compatibility:',
    '  - name: "demo"',
    '    base-url: "https://example.com/v1"',
    '    api-key-entries:',
    '      - api-key: "compat-FAKE-1"',
    '        proxy-url: ""',
  ].join('\n')

  it('redacts every key and keeps the rest', () => {
    for (const file of ['config.yaml', '.cliproxyapi/config.yaml']) {
      const r = redact(text, { rules: plugin.redact, file })
      const out = r.text.split('\n')
      expect(out[3]).toBe(`  secret-key: "${m('secret-key', 'mgmt-FAKE-1')}"`)
      expect(out[5]).toBe(`  - "${m('api-keys', 'client-FAKE-1')}"`)
      expect(out[6]).toBe(`  # - "${m('api-keys', 'client-FAKE-old')}"`)
      expect(out[8]).toBe(`  - api-key: "${m('api-key', 'gem-FAKE-1')}"`)
      expect(out[14]).toBe(`      - api-key: "${m('api-key', 'compat-FAKE-1')}"`)
      expect(out[9]).toBe('    base-url: "https://example.com"')
      expect(out[11]).toBe('  - name: "demo"')
      expect(r.count).toBe(5)
    }
  })

  it('keeps the file valid YAML', () => {
    const r = redact(text, { rules: plugin.redact, file: 'config.yaml' })
    const doc = yaml.load(r.text) as { port: number; 'api-keys': string[] }
    expect(doc.port).toBe(8317)
    expect(doc['api-keys'][0]).toBe(m('api-keys', 'client-FAKE-1'))
  })
})

describe('rules on pretty-printed JSON', () => {
  it('follows nesting by indent', () => {
    const text = '{\n  "auth": {\n    "code": "abc123x"\n  },\n  "code": "keep-me"\n}'
    const r = redact(text, { rules: [{ files: ['*.json'], keys: ['auth.code'] }], file: 'a.json' })
    expect(r.text).toBe(`{\n  "auth": {\n    "code": "${m('code', 'abc123x')}"\n  },\n  "code": "keep-me"\n}`)
  })
})
