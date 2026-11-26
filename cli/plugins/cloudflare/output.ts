// Terminal output helpers for cf-tunnel commands, and the interactive prompt.

// ── Output helpers ───────────────────────────────────────────────────────────

export function die(msg: string): never {
  console.error(`\x1b[31mERROR: ${msg}\x1b[0m`)
  process.exit(1)
}

export function info(msg: string) {
  console.log(`  ${msg}`)
}

export function pass(msg: string) {
  console.log(`  \x1b[32m✓\x1b[0m ${msg}`)
}

export function fail(msg: string) {
  console.warn(`  \x1b[31m✗\x1b[0m ${msg}`)
}

export function header(msg: string) {
  console.log(`\n\x1b[36m=== ${msg} ===\x1b[0m`)
}

// ── Interactive prompt ───────────────────────────────────────────────────────

export async function promptForInput(prompt: string): Promise<string> {
  process.stdout.write(prompt)
  const reader = Bun.stdin.stream().getReader()
  const { value } = await reader.read()
  reader.releaseLock()
  return new TextDecoder().decode(value).trim()
}
