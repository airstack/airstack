/**
 * merge.ts — layered config merge with an origin map.
 *
 * Rules (plans/phase-1.md 4.4):
 *   - maps merge deeply; the higher (later) layer wins per key
 *   - lists replace whole (a list is a leaf)
 *   - `null` in a higher layer deletes the inherited key
 *
 * The origin map records, for every leaf path that survives, which layer set it.
 * Paths are dot-joined keys (`plugins.airstack/cron.crons.backup`). A key that itself
 * contains a dot is written in brackets: `values["a.b"]`.
 */

export type Plain = Record<string, unknown>

export interface Layer {
  /** Origin label, e.g. `default`, `stack:stacks/nodestack/stack.yaml`, `machine:machines/x.yaml` */
  name: string
  value: Plain | undefined
}

export interface MergeResult {
  value: Plain
  origins: Map<string, string>
}

export function isPlainObject(v: unknown): v is Plain {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

export function joinPath(base: string, key: string): string {
  const seg = key.includes('.') ? `["${key}"]` : key
  if (!base) return seg
  return seg.startsWith('[') ? `${base}${seg}` : `${base}.${seg}`
}

/** Merge layers lowest → highest. Inputs are not mutated. */
export function mergeLayers(layers: Layer[]): MergeResult {
  const origins = new Map<string, string>()
  let value: Plain = {}
  for (const layer of layers) {
    if (!layer.value) continue
    value = mergeInto(value, layer.value, '', layer.name, origins)
  }
  return { value, origins }
}

function mergeInto(base: Plain, over: Plain, path: string, layer: string, origins: Map<string, string>): Plain {
  const out: Plain = { ...base }
  for (const [key, ov] of Object.entries(over)) {
    const p = joinPath(path, key)
    if (ov === null) {
      delete out[key]
      dropOrigins(origins, p)
      continue
    }
    const bv = out[key]
    if (isPlainObject(ov) && isPlainObject(bv)) {
      out[key] = mergeInto(bv, ov, p, layer, origins)
    } else {
      dropOrigins(origins, p)
      out[key] = isPlainObject(ov) ? cloneWithOrigins(ov, p, layer, origins) : structuredClone(ov)
      if (!isPlainObject(ov)) origins.set(p, layer)
    }
  }
  return out
}

function cloneWithOrigins(obj: Plain, path: string, layer: string, origins: Map<string, string>): Plain {
  const out: Plain = {}
  for (const [k, v] of Object.entries(obj)) {
    const p = joinPath(path, k)
    if (v === null) continue
    if (isPlainObject(v)) {
      out[k] = cloneWithOrigins(v, p, layer, origins)
    } else {
      out[k] = structuredClone(v)
      origins.set(p, layer)
    }
  }
  if (Object.keys(obj).length === 0) origins.set(path, layer)
  return out
}

/** Remove origins at `path` and below (a replaced subtree). */
function dropOrigins(origins: Map<string, string>, path: string) {
  for (const k of [...origins.keys()]) {
    if (k === path || k.startsWith(path + '.') || k.startsWith(path + '[')) origins.delete(k)
  }
}
