/**
 * Deploy logger — logs to console and optionally to per-phase log files.
 */

import { writeFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { DeployLogger } from '../types.js'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

export class Logger implements DeployLogger {
  private consoleLevel: number
  private logDir?: string
  private currentPhase = 'init'
  private phaseLogFile?: string

  constructor(consoleLevel: LogLevel = 'info', logDir?: string) {
    this.consoleLevel = LEVELS[consoleLevel]
    this.logDir = logDir
    if (logDir) {
      mkdirSync(logDir, { recursive: true })
    }
  }

  setPhase(phase: string): void {
    this.currentPhase = phase
    if (this.logDir) {
      this.phaseLogFile = join(this.logDir, `${phase}.log`)
    }
  }

  debug(msg: string): void {
    this.writeLog('debug', msg)
    if (this.consoleLevel <= LEVELS.debug) {
      console.debug(`\x1b[90m${msg}\x1b[0m`)
    }
  }

  info(msg: string): void {
    this.writeLog('info', msg)
    if (this.consoleLevel <= LEVELS.info) {
      console.log(`\x1b[36m${msg}\x1b[0m`)
    }
  }

  warn(msg: string): void {
    this.writeLog('warn', msg)
    if (this.consoleLevel <= LEVELS.warn) {
      console.warn(`\x1b[33m${msg}\x1b[0m`)
    }
  }

  error(msg: string): void {
    this.writeLog('error', msg)
    if (this.consoleLevel <= LEVELS.error) {
      console.error(`\x1b[31m${msg}\x1b[0m`)
    }
  }

  /** Write a log line to the current phase log file */
  private writeLog(level: string, msg: string): void {
    if (!this.phaseLogFile) return
    const timestamp = new Date().toISOString()
    const line = `${timestamp} [${level.toUpperCase()}] ${msg}\n`
    try {
      appendFileSync(this.phaseLogFile, line)
    } catch {
      // Silently skip file write errors
    }
  }

  /** Log a remote command and its result.
   *  Errors/warnings get full output; success gets debug-level summary. */
  remote(command: string, result: { stdout: string; stderr: string; exitCode: number }, durationMs: number): void {
    const lines = [
      `$ ${command}`,
      `  exit=${result.exitCode} (${durationMs}ms)`,
    ]
    if (result.stdout.trim()) lines.push(`  stdout: ${result.stdout.trim().slice(0, 500)}`)
    if (result.stderr.trim()) lines.push(`  stderr: ${result.stderr.trim().slice(0, 500)}`)

    if (result.exitCode !== 0) {
      // Log full output for failed commands (visible in deploy logs at info level)
      this.writeLog('error', lines.join('\n'))
      // Also include full untruncated output
      if (result.stdout.trim().length > 500) this.writeLog('error', `  stdout (full): ${result.stdout.trim()}`)
      if (result.stderr.trim().length > 500) this.writeLog('error', `  stderr (full): ${result.stderr.trim()}`)
    } else {
      this.writeLog('debug', lines.join('\n'))
    }
  }

  /** Log an rsync operation */
  rsync(src: string, dest: string, exitCode: number, durationMs: number): void {
    this.debug(`rsync ${src} → ${dest} (exit=${exitCode}, ${durationMs}ms)`)
  }
}
