import { describe, it, expect } from 'vitest'
import { parseYamlWithRefs, resolveRefs } from '../../../cli/lib/vars'

const load = (text: string, secrets: Record<string, string>, mode: 'resolve' | 'display' = 'resolve') => {
  const { data, refs } = parseYamlWithRefs(text, 't.yaml')
  return resolveRefs(data, refs, secrets, mode)
}

describe('${VAR} after parse', () => {
  it('a secret with YAML-significant characters cannot change structure', () => {
    const r = load('a: ${S}\nb: 2\n', { S: 'x: y # z\nc: injected' })
    expect(r.value).toEqual({ a: 'x: y # z\nc: injected', b: 2 })
  })

  it('works inside flow maps and lists', () => {
    const r = load('env: { T: ${T}, C: ${C} }\nports: [${P}]\n', { T: 'tok', C: '-1001', P: '8317' })
    expect(r.value).toEqual({ env: { T: 'tok', C: '-1001' }, ports: ['8317'] })
  })

  it('defaults apply when missing or empty; explicit empty default allowed', () => {
    const r = load('a: ${X:-def}\nb: ${E:-fallback}\nc: ${N:-}\n', { E: '' })
    expect(r.value).toEqual({ a: 'def', b: 'fallback', c: '' })
    expect(r.missing).toEqual([])
  })

  it('collects every missing name instead of using empty strings', () => {
    const r = load('a: ${ONE}\nb: x-${TWO}-y\n', {})
    expect(r.missing).toEqual(['ONE', 'TWO'])
  })

  it('refs in comments are not required', () => {
    const r = load('a: 1 # ${NOPE}\n# b: ${ALSO_NOPE}\n', {})
    expect(r.missing).toEqual([])
    expect(r.value).toEqual({ a: 1 })
  })

  it('display mode keeps the original reference text', () => {
    const r = load('a: ${S}\nb: pre-${S:-d}\n', { S: 'secret' }, 'display')
    expect(r.value).toEqual({ a: '${S}', b: 'pre-${S:-d}' })
  })

  it('rejects duplicate keys and invalid references', () => {
    expect(() => parseYamlWithRefs('a: 1\na: 2\n', 'dup.yaml')).toThrow(/duplicat/i)
    expect(() => parseYamlWithRefs('a: ${not valid}\n', 'bad.yaml')).toThrow(/invalid reference/)
  })

  it('tracks which names were used', () => {
    const r = load('a: ${A}\nb: ${B:-x}\n', { A: '1', B: '2', C: '3' })
    expect(r.used).toEqual(['A', 'B'])
  })
})
