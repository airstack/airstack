/**
 * access.ts — the Cloudflare Access guard (plugins.airstack/cloudflare.access).
 *
 *   access:
 *     required: true        # every public tunnel hostname must be behind Cloudflare Access (default true)
 *     exempt: [hooks.example.com, app.example.com/webhook]   # public on purpose (hostname or hostname/path)
 *     onDeploy: refuse      # refuse | warn  (default refuse)
 *     onScan: alert         # alert | stop   (default alert; stop = the 15-minute check stops cloudflared)
 *
 * The classifier is the same as `host_security.sh --access` (keep the two in step):
 *   protected    3xx to https://<team>.cloudflareaccess.com/cdn-cgi/access/…, or the Access 403 page
 *   unknown      no answer, DNS failure, or a Cloudflare/tunnel 5xx (502-504, 520-530). Never "public".
 *   unprotected  anything else: the origin answered (200, an app 401/404, a redirect elsewhere, …)
 */

export interface AccessConfig {
  required: boolean
  exempt: string[]
  onDeploy: 'refuse' | 'warn'
  onScan: 'alert' | 'stop'
}

export type AccessState = 'protected' | 'unknown' | 'unprotected'

export interface IngressRule {
  hostname: string
  /** cloudflared path rule (a regex), or '' for the whole hostname. */
  path: string
  service: string
}

export interface RouteResult {
  label: string
  url: string
  service: string
  state: AccessState
  code: number
  exempt: boolean
}

export interface ProbeAnswer {
  code: number
  location: string
  /** True when a 403 body is the Cloudflare Access page. */
  access403: boolean
}

export type Prober = (url: string) => Promise<ProbeAnswer>

const KNOWN_KEYS = ['required', 'exempt', 'onDeploy', 'onScan']

export function parseAccessConfig(raw: unknown): AccessConfig {
  const a = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  for (const k of Object.keys(a)) {
    if (!KNOWN_KEYS.includes(k)) throw new Error(`access.${k}: unknown key (known: ${KNOWN_KEYS.join(', ')})`)
  }
  const required = a.required === undefined ? true : a.required
  if (typeof required !== 'boolean') throw new Error('access.required must be true or false')
  const exempt = a.exempt === undefined ? [] : a.exempt
  if (!Array.isArray(exempt) || exempt.some((e) => typeof e !== 'string' || !/^[a-z0-9.-]+(\/[^\s]*)?$/i.test(e))) {
    throw new Error('access.exempt must be a list of hostnames or hostname/path entries')
  }
  const onDeploy = a.onDeploy ?? 'refuse'
  if (onDeploy !== 'refuse' && onDeploy !== 'warn') throw new Error('access.onDeploy must be refuse or warn')
  const onScan = a.onScan ?? 'alert'
  if (onScan !== 'alert' && onScan !== 'stop') throw new Error('access.onScan must be alert or stop')
  return { required, exempt: exempt as string[], onDeploy, onScan }
}

/** cloudflared metrics `/config` JSON → rules that have a hostname (catch-all rules are dropped). */
export function parseIngress(json: string): IngressRule[] | undefined {
  let data: unknown
  try {
    data = JSON.parse(json)
  } catch {
    return undefined
  }
  const root = data as { config?: { ingress?: unknown }; ingress?: unknown }
  const ingress = root?.config?.ingress ?? root?.ingress
  if (!Array.isArray(ingress)) return undefined
  return ingress
    .filter((r) => r && typeof r === 'object' && typeof r.hostname === 'string' && r.hostname)
    .map((r) => ({ hostname: r.hostname, path: typeof r.path === 'string' ? r.path : '', service: String(r.service ?? '') }))
}

/** Literal path prefix to probe for a cloudflared path rule: "^/admin/.*" → "/admin/". */
export function probePath(rule: string): string {
  if (!rule) return '/'
  let p = rule.replace(/^\^/, '').replace(/^\//, '')
  p = p.replace(/[\].*+?()[{|\\$].*$/, '')
  return `/${p}`
}

export function classify(a: ProbeAnswer): AccessState {
  const { code } = a
  if ([301, 302, 303, 307, 308].includes(code) && /^https:\/\/[A-Za-z0-9-]+\.cloudflareaccess\.com\/cdn-cgi\/access\//.test(a.location)) {
    return 'protected'
  }
  if (code === 403 && a.access403) return 'protected'
  if (code === 0 || [502, 503, 504, 530].includes(code) || (code >= 520 && code <= 529)) return 'unknown'
  return 'unprotected'
}

export function isExempt(exempt: string[], hostname: string, path: string): boolean {
  return exempt.some((e) => e === hostname || e === hostname + path || e === hostname + path.replace(/\/$/, ''))
}

/** One unauthenticated HTTPS request, redirects not followed. Network errors answer code 0. */
export const fetchProber: Prober = async (url) => {
  try {
    const res = await fetch(url, {
      redirect: 'manual',
      headers: { 'user-agent': 'airstack-access-check' },
      signal: AbortSignal.timeout(10_000),
    })
    let access403 = false
    if (res.status === 403) {
      const body = (await res.text()).slice(0, 65536)
      access403 = /cloudflareaccess\.com|Cloudflare Access/i.test(body)
    } else {
      await res.body?.cancel()
    }
    return { code: res.status, location: res.headers.get('location') ?? '', access403 }
  } catch {
    return { code: 0, location: '', access403: false }
  }
}

export async function checkRoutes(rules: IngressRule[], cfg: AccessConfig, probe: Prober = fetchProber): Promise<RouteResult[]> {
  return Promise.all(rules.map(async (r) => {
    const path = probePath(r.path)
    const url = `https://${r.hostname}${path}`
    const answer = await probe(url)
    return {
      label: r.hostname + (path === '/' ? '' : path),
      url,
      service: r.service,
      state: classify(answer),
      code: answer.code,
      exempt: isExempt(cfg.exempt, r.hostname, path),
    }
  }))
}

/** Routes that break the guard: unprotected, not exempt, and access.required is on. */
export function violations(results: RouteResult[], cfg: AccessConfig): RouteResult[] {
  if (!cfg.required) return []
  return results.filter((r) => r.state === 'unprotected' && !r.exempt)
}
