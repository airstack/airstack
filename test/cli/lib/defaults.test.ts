import { describe, it, expect } from 'vitest'
import { resolveDefaults } from '../../../cli/lib/defaults'

describe('resolveDefaults', () => {
  it('no <<+ → unchanged', () => {
    const input = { stack: { services: { 'my-service': { timezone: 'UTC' } } } }
    expect(resolveDefaults(input)).toEqual(input)
  })

  it('simple top-level dot-path merge', () => {
    const input = {
      base: { color: 'blue', size: 10 },
      item: { '<<+': 'base', size: 20 },
    }
    const result = resolveDefaults(input)
    expect(result.item).toEqual({ color: 'blue', size: 20 })
  })

  it('nested dot-path (stack.serviceDefaults)', () => {
    const input = {
      stack: {
        serviceDefaults: { timezone: 'UTC', resources: { cpu: 4 } },
        services: {
          'my-service': {
            '<<+': 'stack.serviceDefaults',
            resources: { memory: '8G' },
          },
        },
      },
    }
    const result = resolveDefaults(input)
    expect(result.stack.services['my-service']).toEqual({
      timezone: 'UTC',
      resources: { cpu: 4, memory: '8G' },
    })
  })

  it('current values win over defaults (deep)', () => {
    const input = {
      defaults: { a: 1, nested: { x: 10, y: 20 } },
      item: { '<<+': 'defaults', a: 99, nested: { x: 42 } },
    }
    const result = resolveDefaults(input)
    expect(result.item).toEqual({ a: 99, nested: { x: 42, y: 20 } })
  })

  it('preserves the defaults source object unchanged', () => {
    const input = {
      base: { color: 'blue', size: 10 },
      item: { '<<+': 'base', color: 'red' },
    }
    const result = resolveDefaults(input)
    // source untouched in result
    expect(result.base).toEqual({ color: 'blue', size: 10 })
    // original input untouched
    expect(input.base).toEqual({ color: 'blue', size: 10 })
  })

  it('missing dot-path → gracefully handled (key removed, object otherwise intact)', () => {
    const input = {
      item: { '<<+': 'does.not.exist', value: 42 },
    }
    const result = resolveDefaults(input)
    expect(result.item).toEqual({ value: 42 })
    expect('<<+' in result.item).toBe(false)
  })

  it('non-recursive: leaf references mid which references base — leaf does NOT get base values', () => {
    // base → mid → leaf chain
    // Non-recursive means: when resolving leaf.<<+="mid", we look up `mid`
    // in the original root (un-resolved). So leaf only gets mid's own values,
    // NOT mid merged with base.
    const input = {
      base: { a: 1, b: 2 },
      mid: { '<<+': 'base', b: 99, c: 3 },
      leaf: { '<<+': 'mid', c: 100 },
    }
    const result = resolveDefaults(input)

    // mid itself is resolved (it has <<+)
    expect(result.mid).toEqual({ a: 1, b: 99, c: 3 })

    // leaf references original `mid` (which still has <<+ in the original root)
    // Non-recursive means: leaf merges with original mid = { <<+: 'base', b: 99, c: 3 }
    // After merge, leaf should have b=99, c=100 from current, and <<+ removed
    // But NOT a=1 from base (that would be recursive)
    expect(result.leaf).not.toHaveProperty('a')
    expect(result.leaf).toEqual({ b: 99, c: 100 })
  })

  it('multiple <<+ entries across tree', () => {
    const input = {
      defaults_a: { x: 1 },
      defaults_b: { y: 2 },
      node_a: { '<<+': 'defaults_a', z: 3 },
      node_b: { '<<+': 'defaults_b', z: 4 },
    }
    const result = resolveDefaults(input)
    expect(result.node_a).toEqual({ x: 1, z: 3 })
    expect(result.node_b).toEqual({ y: 2, z: 4 })
  })

  it('removes <<+ key from result', () => {
    const input = {
      base: { val: 1 },
      item: { '<<+': 'base' },
    }
    const result = resolveDefaults(input)
    expect('<<+' in result.item).toBe(false)
  })

  it('does not mutate the input', () => {
    const input = {
      base: { x: 1 },
      item: { '<<+': 'base', y: 2 },
    }
    const inputSnapshot = JSON.stringify(input)
    resolveDefaults(input)
    expect(JSON.stringify(input)).toBe(inputSnapshot)
  })

  it('arrays are treated as scalars (target array replaces source)', () => {
    const input = {
      defaults: { tags: ['a', 'b'], name: 'default' },
      item: { '<<+': 'defaults', tags: ['c'] },
    }
    const result = resolveDefaults(input)
    expect(result.item).toEqual({ tags: ['c'], name: 'default' })
  })

  it('deeply nested objects with <<+ are all resolved', () => {
    const input = {
      shared: { flag: true },
      outer: {
        inner: {
          '<<+': 'shared',
          extra: 'yes',
        },
      },
    }
    const result = resolveDefaults(input)
    expect(result.outer.inner).toEqual({ flag: true, extra: 'yes' })
  })

  it('dot-path pointing to a non-object is silently ignored', () => {
    const input = {
      scalar: 42,
      item: { '<<+': 'scalar', value: 'hello' },
    }
    const result = resolveDefaults(input)
    expect(result.item).toEqual({ value: 'hello' })
    expect('<<+' in result.item).toBe(false)
  })
})
