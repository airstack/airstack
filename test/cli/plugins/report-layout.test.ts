// lib/report.sh (daily report layout), the machine check parser, and cron reportTitle.

import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseReportChecks } from '../../../cli/commands/machine/read'

const LIB = join(__dirname, '../../../cli/plugins/cron/deploy/lib/report.sh')

function sh(script: string): string {
  return execFileSync('bash', ['-c', `set -euo pipefail; source "${LIB}"; ${script}`], { encoding: 'utf-8' })
}

describe('lib/report.sh', () => {
  it('renders header, problems with detail and fix, overview, and one passed line', () => {
    const out = sh(`
      report_problem "⚠️" "Security updates pending: 2" "apt: libfoo libbar"
      report_line "⚠️ Keys, sudoers, services: since last run: removed: unit:old.service"
      report_pass "✅ Disk: 12% of 290 GB"
      report_line "✅ Firewall: active, deny by default"
      REPORT_OVERVIEW="✅ Disk good: 88% free of 290 GB"
      report_render "📊 VPS web-1" "Host: web-1 · 192.0.2.10" "290 GB disk · 46 GB RAM · ⏱ up 2 days"`)
    expect(out).toBe([
      '<b>📊 VPS web-1 — Daily Status</b>',
      'Host: web-1 · 192.0.2.10',
      '290 GB disk · 46 GB RAM · ⏱ up 2 days',
      '',
      '<b>⚡ 2 need attention</b>',
      '',
      '⚠️ <b>Security updates pending: 2</b>',
      '   apt: libfoo libbar',
      '   🔧 <code>sudo apt-get update &amp;&amp; sudo apt-get upgrade</code>',
      '',
      '⚠️ <b>Keys, sudoers, services</b>',
      '   Removed since last run: unit:old.service',
      '   🔧 <code>nothing, if you made this change: the next run accepts it</code>',
      '',
      '───',
      '✅ Disk good: 88% free of 290 GB',
      '───',
      '✅ 2 checks passed: Disk, Firewall',
      '',
    ].join('\n'))
  })

  it('all good: one line, no problems block', () => {
    const out = sh(`report_pass "✅ Docker"; report_render "📊 web-1" "Host: web-1" "1 GB disk"`)
    expect(out).toContain('<b>✅ All checks passed</b>')
    expect(out).toContain('✅ 1 checks passed: Docker')
  })

  it('full mode lists every passed check and the details', () => {
    const out = sh(`REPORT_FULL=true; REPORT_DETAILS="• Packages upgradable: 3"; report_pass "✅ Docker"; report_render "t" "h" "s"`)
    expect(out).toContain('───\n✅ Docker\n\n<b>Details</b>\n• Packages upgradable: 3')
  })

  it('undoes the HTML escaping of host_security lines, then escapes once', () => {
    const out = sh(`report_line "⚠️ SSH: a &amp; b &lt;x&gt;"; report_render "t" "h" "s"`)
    expect(out).toContain('   a &amp; b &lt;x&gt;')
  })

  it('wrap_list: two lines at most, then +N', () => {
    expect(sh('wrap_list 20 aaaa bbbb cccc dddd eeee ffff gggg hhhh')).toBe('aaaa bbbb cccc dddd\neeee ffff gggg hhhh\n')
    expect(sh('wrap_list 10 aaaa bbbb cccc dddd eeee ffff')).toBe('aaaa bbbb\ncccc dddd +2\n')
    expect(sh('wrap_list 50 one two')).toBe('one two\n')
  })

  it('fix_for: known titles get a fix, unknown get none', () => {
    expect(sh('fix_for "Reboot required"')).toBe('sudo reboot (at a quiet time)')
    expect(sh('fix_for "web-a-whoami: stopped"')).toContain('airstack machine logs')
    expect(sh('fix_for "Something new"')).toBe('')
  })
})

describe('parseReportChecks (airstack machine check)', () => {
  const text = [
    'web-1 — Daily Status', 'Host: web-1', '', '⚡ 1 need attention', '',
    '⚠️ Security updates pending: 2', '   apt: libfoo libbar', '   🔧 sudo apt-get update', '',
    '───', '✅ Disk good: 88% free', '───', '✅ Docker', '✅ Firewall: active', '', 'Details', '• x',
  ].join('\n')

  it('one line per problem with its first detail and fix; overview lines are not checks', () => {
    expect(parseReportChecks(text, false)).toEqual([
      { level: 'warn', text: 'Security updates pending: 2: apt: libfoo libbar (fix: sudo apt-get update)' },
    ])
  })
  it('-v adds the passed checks', () => {
    expect(parseReportChecks(text, true).filter((c) => c.level === 'ok').map((c) => c.text)).toEqual(['Docker', 'Firewall: active'])
  })
})

describe('cron reportTitle', () => {
  it('goes to every host_ cron env, unless the cron sets its own', async () => {
    const { parseConfigForTest } = await import('../../../cli/plugins/cron/index')
    const c = parseConfigForTest({
      reportTitle: '📊 VPS web-1',
      crons: {
        host_alerter: '*/15 * * * *',
        host_alerter_report: { schedule: '9:30 AM', env: { REPORT_TITLE: 'own' } },
        backup: '3:00 AM',
      },
    })
    expect(c.crons.host_alerter.vars.REPORT_TITLE).toBe('📊 VPS web-1')
    expect(c.crons.host_alerter_report.vars.REPORT_TITLE).toBe('own')
    expect(c.crons.backup.vars.REPORT_TITLE).toBeUndefined()
    expect(() => parseConfigForTest({ reportTitle: 'a\nb', crons: {} })).toThrow(/one line/)
  })
})
