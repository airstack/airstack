// fleet-lint.ts — machine-wide checks across stack instances.
// The code lives in ./fleet-lint/. This file re-exports it so importers keep one path.

export { lintMachine, parsePortEntry } from './fleet-lint/index.js'
