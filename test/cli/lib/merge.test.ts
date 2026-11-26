import { describe, it, expect } from 'vitest'
import { mergeLayers } from '../../../cli/lib/merge'

describe('mergeLayers', () => {
  it('deep-merges maps; the higher layer wins per key', () => {
    const r = mergeLayers([
      { name: 'stack', value: { values: { port: 3000, greeting: 'hi' }, user: 'a' } },
      { name: 'machine', value: { values: { port: 3001 } } },
    ])
    expect(r.value).toEqual({ values: { port: 3001, greeting: 'hi' }, user: 'a' })
    expect(r.origins.get('values.port')).toBe('machine')
    expect(r.origins.get('values.greeting')).toBe('stack')
    expect(r.origins.get('user')).toBe('stack')
  })

  it('replaces lists whole', () => {
    const r = mergeLayers([
      { name: 'stack', value: { ports: [1, 2, 3] } },
      { name: 'machine', value: { ports: [9] } },
    ])
    expect(r.value.ports).toEqual([9])
    expect(r.origins.get('ports')).toBe('machine')
  })

  it('null deletes an inherited key and its origins', () => {
    const r = mergeLayers([
      { name: 'stack', value: { values: { a: 1, nested: { x: 1 } } } },
      { name: 'machine', value: { values: { nested: null } } },
    ])
    expect(r.value).toEqual({ values: { a: 1 } })
    expect([...r.origins.keys()].some((k) => k.startsWith('values.nested'))).toBe(false)
  })

  it('a scalar replacing a map drops the old subtree origins', () => {
    const r = mergeLayers([
      { name: 'stack', value: { x: { a: 1, b: 2 } } },
      { name: 'machine', value: { x: 'flat' } },
    ])
    expect(r.value.x).toBe('flat')
    expect(r.origins.get('x')).toBe('machine')
    expect(r.origins.has('x.a')).toBe(false)
  })

  it('brackets keys that contain dots and does not mutate inputs', () => {
    const stack = { templates: { 'compose.yaml': { src: 'a.hbs' } } }
    const r = mergeLayers([{ name: 'stack', value: stack }, { name: 'machine', value: { templates: { 'compose.yaml': { src: 'b.hbs' } } } }])
    expect(r.origins.get('templates["compose.yaml"].src')).toBe('machine')
    expect(stack.templates['compose.yaml'].src).toBe('a.hbs')
  })

  it('records an empty map as a leaf', () => {
    const r = mergeLayers([{ name: 'stack', value: { plugins: { 'airstack/cliproxyapi': {} } } }])
    expect(r.origins.get('plugins.airstack/cliproxyapi')).toBe('stack')
  })
})
