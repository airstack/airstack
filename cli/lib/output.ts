/**
 * output.ts — the one formatter for agent-first CLI output.
 *
 * Every line starts with a stable prefix so agents can grep it:
 *   ok    something checked out
 *   warn  needs attention, not fatal
 *   fail  broken
 *   ->    the next command to run
 *   (no prefix) plain information / data lines
 *
 * Exit codes: 0 ok, 1 warnings, 2 failures, 3 usage error or blocked verb.
 * Color only on a TTY. All CLI output should go through here so `--json` can be added later.
 */

export const EXIT = { OK: 0, WARN: 1, FAIL: 2, USAGE: 3 } as const

const tty = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR
const color = (code: string, s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s)

export class Output {
  warnings = 0
  failures = 0
  readonly lines: string[] = []
  constructor(private sink: (line: string) => void = (l) => console.log(l)) {}

  private emit(line: string) {
    this.lines.push(line)
    this.sink(line)
  }

  ok(msg: string) { this.emit(`${color('32', 'ok')}   ${msg}`) }
  warn(msg: string) { this.warnings++; this.emit(`${color('33', 'warn')} ${msg}`) }
  fail(msg: string) { this.failures++; this.emit(`${color('31', 'fail')} ${msg}`) }
  next(cmd: string) { this.emit(`${color('36', '->')}   ${cmd}`) }
  info(msg: string) { this.emit(msg) }

  /** Exit code from what was emitted. */
  code(): number {
    if (this.failures > 0) return EXIT.FAIL
    if (this.warnings > 0) return EXIT.WARN
    return EXIT.OK
  }
}
