import { describe, it, expect } from 'vitest'
import { parsePorts, parseManagedRules, planRules, parseServe, parseServeStatus, planServe, RULE_COMMENT } from '../../../cli/plugins/tailscale/index'

describe('tailscale plugin', () => {
  describe('parsePorts', () => {
    it('defaults to tcp and accepts port/proto strings', () => {
      expect(parsePorts([8317, '53/udp', '9000/TCP'])).toEqual([
        { port: 8317, proto: 'tcp' },
        { port: 53, proto: 'udp' },
        { port: 9000, proto: 'tcp' },
      ])
    })

    it('dedupes', () => {
      expect(parsePorts([8317, '8317/tcp'])).toEqual([{ port: 8317, proto: 'tcp' }])
    })

    it('treats missing as empty', () => {
      expect(parsePorts(undefined)).toEqual([])
    })

    it('rejects invalid entries', () => {
      expect(() => parsePorts(['abc'])).toThrow(/invalid entry/)
      expect(() => parsePorts([70000])).toThrow(/invalid entry/)
      expect(() => parsePorts('8317')).toThrow(/must be a list/)
    })
  })

  describe('parseManagedRules', () => {
    const status = [
      'Status: active',
      '',
      'To                         Action      From',
      '--                         ------      ----',
      '222/tcp                    ALLOW       Anywhere',
      `8317/tcp on tailscale0     ALLOW       Anywhere                   # ${RULE_COMMENT}`,
      `53/udp on tailscale0       ALLOW       Anywhere                   # ${RULE_COMMENT}`,
      '9999/tcp on tailscale0     ALLOW       Anywhere                   # hand-made',
      '222/tcp (v6)               ALLOW       Anywhere (v6)',
      `8317/tcp (v6) on tailscale0 ALLOW      Anywhere (v6)              # ${RULE_COMMENT}`,
    ].join('\n')

    it('returns only tagged tailscale0 rules, collapsing v4/v6', () => {
      expect(parseManagedRules(status)).toEqual([
        { port: 8317, proto: 'tcp' },
        { port: 53, proto: 'udp' },
      ])
    })
  })

  describe('planRules', () => {
    it('adds missing and removes stale rules', () => {
      const plan = planRules(
        [{ port: 8317, proto: 'tcp' }, { port: 9000, proto: 'tcp' }],
        [{ port: 8317, proto: 'tcp' }, { port: 53, proto: 'udp' }],
      )
      expect(plan.add).toEqual([{ port: 9000, proto: 'tcp' }])
      expect(plan.remove).toEqual([{ port: 53, proto: 'udp' }])
    })
  })

  describe('parseServe', () => {
    it('is undefined when the key is absent (deploy leaves forwards alone)', () => {
      expect(parseServe(undefined)).toBeUndefined()
      expect(parseServe(null)).toBeUndefined()
    })

    it('treats an empty list as "remove all forwards"', () => {
      expect(parseServe([])).toEqual([])
    })

    it('forwards a bare port to the same loopback port', () => {
      expect(parseServe([3773, '8080'])).toEqual([
        { port: 3773, target: '127.0.0.1:3773' },
        { port: 8080, target: '127.0.0.1:8080' },
      ])
    })

    it('accepts { port, to } and dedupes by port (last wins)', () => {
      expect(parseServe([{ port: 8080, to: '127.0.0.1:9000' }, { port: 8080, to: 'localhost:9001' }])).toEqual([
        { port: 8080, target: 'localhost:9001' },
      ])
      expect(parseServe([{ port: 80, to: '[::1]:9000' }])).toEqual([{ port: 80, target: '[::1]:9000' }])
    })

    it('rejects non-loopback targets, bad ports, and non-lists', () => {
      expect(() => parseServe([{ port: 80, to: '10.0.0.5:80' }])).toThrow(/loopback/)
      expect(() => parseServe([{ port: 80, to: 'example.com:80' }])).toThrow(/loopback/)
      expect(() => parseServe([{ port: 80, to: '127.0.0.1' }])).toThrow(/loopback/)
      expect(() => parseServe([{ port: 80, to: '127.0.0.1:99999' }])).toThrow(/loopback/)
      expect(() => parseServe(['abc'])).toThrow(/invalid port/)
      expect(() => parseServe([0])).toThrow(/invalid port/)
      expect(() => parseServe([70000])).toThrow(/invalid port/)
      expect(() => parseServe(3773)).toThrow(/must be a list/)
    })
  })

  describe('parseServeStatus', () => {
    it('reads TCP forwards', () => {
      const json = JSON.stringify({ TCP: { '3773': { TCPForward: '127.0.0.1:3773' }, '443': { HTTPS: true } } })
      expect([...parseServeStatus(json)]).toEqual([[3773, '127.0.0.1:3773']])
    })

    it('treats empty config as no forwards', () => {
      expect(parseServeStatus('{}').size).toBe(0)
      expect(parseServeStatus('').size).toBe(0)
    })

    it('throws on unparseable output', () => {
      expect(() => parseServeStatus('No serve config')).toThrow(/could not parse/)
    })
  })

  describe('planServe', () => {
    const t = (port: number, target = `127.0.0.1:${port}`) => ({ port, target })

    it('does nothing when forwards match', () => {
      expect(planServe([t(3773)], new Map([[3773, '127.0.0.1:3773']]))).toEqual({ add: [], remove: [] })
    })

    it('adds missing, re-adds a changed target, removes unlisted', () => {
      const plan = planServe(
        [t(3773), t(8080, '127.0.0.1:9000'), t(5000)],
        new Map([[3773, '127.0.0.1:3773'], [8080, '127.0.0.1:8080'], [9999, '127.0.0.1:9999']]),
      )
      expect(plan.add).toEqual([t(8080, '127.0.0.1:9000'), t(5000)])
      expect(plan.remove).toEqual([9999])
    })

    it('an empty desired list removes everything', () => {
      expect(planServe([], new Map([[3773, '127.0.0.1:3773']]))).toEqual({ add: [], remove: [3773] })
    })
  })
})
