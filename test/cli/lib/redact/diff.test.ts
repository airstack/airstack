import { describe, it, expect } from 'vitest'
import { redactDiff, shortHash } from '../../../../cli/lib/redact/index'

const m = (label: string, value: string) => `[redacted:${label}:${shortHash(value)}]`

describe('redactDiff', () => {
  const diff = [
    'diff --git a/conf/app.yaml b/conf/app.yaml',
    'index 1111111..2222222 100644',
    '--- a/conf/app.yaml',
    '+++ b/conf/app.yaml',
    '@@ -1,4 +1,4 @@',
    ' upstream:',
    '-  - old-value-1',
    '+  - new-value-2',
    ' port: 8317',
    '-password: oldpass99',
    '+password: newpass99',
    '\\ No newline at end of file',
  ].join('\n')

  it('redacts body lines, keeps headers, and shows that a secret changed', () => {
    const r = redactDiff(diff, { rules: [{ files: ['conf/*.yaml'], keys: ['upstream'] }] })
    const out = r.text.split('\n')
    expect(out.slice(0, 5)).toEqual(diff.split('\n').slice(0, 5))
    expect(out[6]).toBe(`-  - ${m('upstream', 'old-value-1')}`)
    expect(out[7]).toBe(`+  - ${m('upstream', 'new-value-2')}`)
    expect(out[8]).toBe(' port: 8317')
    expect(out[9]).toBe(`-password: ${m('password', 'oldpass99')}`)
    expect(out[10]).toBe(`+password: ${m('password', 'newpass99')}`)
    expect(out[11]).toBe('\\ No newline at end of file')
    expect(r.hits.map(h => h.line)).toEqual([7, 8, 10, 11])
  })

  it('uses opts.file over the header path', () => {
    const r = redactDiff(diff, { rules: [{ files: ['conf/*.yaml'], keys: ['upstream'] }], file: 'other.yaml' })
    expect(r.text).toContain('-  - old-value-1')
  })
})
