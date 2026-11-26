/**
 * fleet.ts — fleet repo loader (plans/phase-1.md sections 3 and 4).
 *
 *   airstack.yaml                 fleet marker + version pin
 *   machines/<m>.yaml             machine (simple form)
 *   machines/<m>/machine.yaml     machine (dir form, may hold deploy/ files)
 *   stacks/<s>/stack.yaml         reusable stack
 *   plugins/<p>/index.ts          fleet plugin (bare name)
 *   .airstack/secrets/_fleet.jsonc, <machine>.jsonc   secrets (gitignored)
 *
 * References: `stack: x` / plugin `x` resolve in the fleet repo ONLY; built-ins are always
 * `airstack/x`. A bare name never falls back to a built-in (typo / rename protection).
 */
// The code lives in ./fleet/. This file re-exports it so importers keep one path.

export { CORE_ROOT, BUILTIN_PLUGINS_DIR, BUILTIN_STACKS_DIR } from './core.js'
export { BUILTIN_PREFIX, DEFAULT_MACHINE_ROOT } from './fleet/util.js'
export * from './fleet/types.js'
export * from './fleet/discover.js'
export * from './fleet/secrets.js'
export * from './fleet/refs.js'
export * from './fleet/machine.js'
