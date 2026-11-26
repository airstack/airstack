/**
 * Parse human-readable schedule time → cron expression + IANA timezone.
 *
 * Accepts: "9:30 AM PST", "9:30 AM America/Los_Angeles", "16:30 UTC", "16:30"
 * Returns: { cronExpr, ianaTz }
 */

import { TZ_ABBREVIATIONS } from './tz-abbreviations.js'

export interface ScheduleTime {
  cronExpr: string
  ianaTz: string
}

export function resolveTz(tzPart: string): string {
  if (!tzPart) return ''
  if (tzPart.includes('/')) return tzPart
  return TZ_ABBREVIATIONS[tzPart.toUpperCase()] || ''
}

export function parseScheduleTime(timeStr: string, label = 'schedule'): ScheduleTime {
  if (!timeStr) return { cronExpr: '', ianaTz: '' }

  const str = timeStr.trim()

  // 12-hour: "3:15 PM" or "3:15 PM PST" or "3:15 PM America/Los_Angeles"
  const match12 = str.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)(?:\s+(.+))?$/i)
  if (match12) {
    let hour = parseInt(match12[1], 10)
    const minute = parseInt(match12[2], 10)
    const ampm = match12[3].toUpperCase()
    const tzPart = match12[4]?.trim() || ''

    if (hour < 1 || hour > 12) throw new Error(`Invalid hour ${hour} in ${label} "${timeStr}"`)
    if (minute > 59) throw new Error(`Invalid minute ${minute} in ${label} "${timeStr}"`)

    if (ampm === 'PM' && hour !== 12) hour += 12
    if (ampm === 'AM' && hour === 12) hour = 0

    return { cronExpr: `${minute} ${hour} * * *`, ianaTz: resolveTz(tzPart) }
  }

  // 24-hour: "16:30" or "16:30 UTC"
  const match24 = str.match(/^(\d{1,2}):(\d{2})(?:\s+(.+))?$/)
  if (match24) {
    const hour = parseInt(match24[1], 10)
    const minute = parseInt(match24[2], 10)
    const tzPart = match24[3]?.trim() || ''

    if (hour > 23) throw new Error(`Invalid hour ${hour} in ${label} "${timeStr}"`)
    if (minute > 59) throw new Error(`Invalid minute ${minute} in ${label} "${timeStr}"`)

    return { cronExpr: `${minute} ${hour} * * *`, ianaTz: resolveTz(tzPart) }
  }

  throw new Error(`Could not parse ${label} time "${timeStr}"`)
}
