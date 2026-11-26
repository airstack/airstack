/**
 * Resolves `<<+` references in a YAML-parsed object tree.
 *
 * Any object with a `<<+: "dot.path"` key will have the referenced
 * object deep-merged as defaults (current values win), then `<<+` is
 * removed from the result.
 *
 * Rules:
 * - Dot-path is resolved against the original (pre-clone) root
 * - Deep merge: current values win at every level
 * - Non-recursive: the referenced target is NOT itself resolved
 * - Missing dot-path → silently ignored (key removed)
 * - Input is not mutated
 */

type AnyObject = Record<string, unknown>

/**
 * Resolve a dot-path string (e.g. "stack.service_defaults") against an object.
 * Returns the value at that path, or undefined if any segment is missing.
 */
function resolveDotPath(root: unknown, path: string): unknown {
  const segments = path.split('.')
  let current: unknown = root
  for (const segment of segments) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as AnyObject)[segment]
  }
  return current
}

/**
 * Deep merge two objects: source provides defaults, target values win.
 * Arrays are treated as scalars (target array replaces source array entirely).
 * Returns a new object — neither input is mutated.
 */
function deepMerge(target: AnyObject, source: AnyObject): AnyObject {
  const result: AnyObject = { ...source }
  for (const key of Object.keys(target)) {
    const targetVal = target[key]
    const sourceVal = source[key]
    if (
      targetVal !== null &&
      typeof targetVal === 'object' &&
      !Array.isArray(targetVal) &&
      sourceVal !== null &&
      typeof sourceVal === 'object' &&
      !Array.isArray(sourceVal)
    ) {
      result[key] = deepMerge(targetVal as AnyObject, sourceVal as AnyObject)
    } else {
      result[key] = targetVal
    }
  }
  return result
}

/**
 * Walk the cloned tree depth-first and resolve any `<<+` keys.
 * The originalRoot is used for dot-path lookups. Parent is used for
 * sibling references (paths without dots, e.g. `$defaults`).
 */
function walk(node: unknown, originalRoot: unknown, originalParent?: AnyObject): unknown {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    return node
  }

  const obj = node as AnyObject

  // Resolve children first (depth-first), but only on non-<<+ children
  // so we don't accidentally resolve a target before we look it up.
  const resolved: AnyObject = {}
  for (const key of Object.keys(obj)) {
    if (key === '<<+') {
      resolved[key] = obj[key]
    } else {
      resolved[key] = walk(obj[key], originalRoot, obj)
    }
  }

  // Now handle <<+ for this node
  if (typeof resolved['<<+'] === 'string') {
    const ref = resolved['<<+'] as string
    delete resolved['<<+']

    // Resolve the reference: try sibling (parent) first, then root dot-path
    let defaults: unknown
    if (!ref.includes('.') && originalParent && ref in originalParent) {
      // Sibling reference — found in parent object (e.g. $defaults → parent.$defaults)
      defaults = originalParent[ref]
    } else {
      // Dot-path or sibling not found in parent — resolve against root
      defaults = resolveDotPath(originalRoot, ref)
    }

    if (defaults !== null && typeof defaults === 'object' && !Array.isArray(defaults)) {
      // Strip <<+ from the source object before merging — non-recursive
      const { '<<+': _ignored, ...cleanDefaults } = defaults as AnyObject & {
        '<<+'?: unknown
      }
      return deepMerge(resolved, cleanDefaults)
    }
    // Missing or non-object ref → just remove the key (already done above)
  }

  return resolved
}

/**
 * Resolve all `<<+` references in the given object tree.
 * Returns a new object (input is not mutated).
 */
export function resolveDefaults<T>(root: T): T {
  const cloned = structuredClone(root)
  return walk(cloned, root) as T
}
