// In-memory compose rendering for lint: render a unit's compose the way deploy does.
// Nothing is printed from the rendered text: it can hold secrets.

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import Handlebars from 'handlebars'
import yaml from 'js-yaml'
import { isPlainObject, type Plain } from '../merge.js'
import { loadPluginRef } from '../fleet-check.js'
import type { Fleet } from '../fleet.js'
import { pluginKey, type DeployUnit } from '../units.js'
import { resolveFileOptional } from '../resolve-file.js'

export interface Rendered {
  doc?: Plain
  /** Compose service name → plugin ref that contributed it. */
  serviceOwners: Map<string, string>
  error?: string
}

/** Render a unit's compose like deploy stage does (no enrichment hooks run). */
export async function renderCompose(fleet: Fleet, unit: DeployUnit): Promise<Rendered> {
  const serviceOwners = new Map<string, string>()
  // Plugins may fill defaults into their config block: work on a copy, never on the Machine.
  const plugins = structuredClone(unit.config.plugins ?? {}) as Record<string, unknown>
  const ctx: Record<string, unknown> = {
    host: unit.config.host,
    stack: unit.config.stack,
    plugins,
    deploy: unit.config.deploy,
    manifest: { entries: {} },
    compose: {},
  }
  const blocks: string[] = []
  for (const { ref } of unit.pluginRefs) {
    const cfg = plugins[pluginKey(ref)]
    let lp
    try {
      lp = await loadPluginRef(fleet.root, ref, cfg)
    } catch {
      continue // load errors are reported by checkPluginScopes
    }
    for (const svc of lp.plugin.composeServices ?? []) {
      const p = join(lp.plugin.sourceDir ?? '', svc.template)
      if (!existsSync(p)) continue // deploy stage reports it
      let block: string
      try {
        block = Handlebars.compile(readFileSync(p, 'utf8'), { noEscape: true })(ctx)
      } catch (e) {
        return { serviceOwners, error: `${ref} service ${svc.name}: ${short(e)}` }
      }
      blocks.push(block)
      try {
        const part = yaml.load(`services:\n${block}`) as Plain | undefined
        if (isPlainObject(part?.services)) for (const name of Object.keys(part.services)) serviceOwners.set(name, ref)
      } catch {
        serviceOwners.set(svc.name, ref)
      }
    }
  }
  ;(ctx.compose as Plain).pluginServices = blocks.join('\n')

  const entry = unit.config.templates['docker-compose.yml']
  if (!entry) return { serviceOwners }
  const src = resolveFileOptional(unit.projectRoot, unit.sharedPaths, entry.src)
  if (!src) return { serviceOwners } // deploy stage reports a missing template
  let text: string
  try {
    text = entry.src.endsWith('.hbs')
      ? Handlebars.compile(readFileSync(src, 'utf8'), { noEscape: true })(ctx)
      : readFileSync(src, 'utf8')
  } catch (e) {
    return { serviceOwners, error: short(e) }
  }
  try {
    const doc = yaml.load(text)
    if (doc == null) return { serviceOwners }
    if (!isPlainObject(doc)) return { serviceOwners, error: 'top level is not a mapping' }
    return { doc, serviceOwners }
  } catch (e) {
    // js-yaml's message quotes the line, which can hold a secret: keep reason + line only.
    const ye = e as { reason?: string; mark?: { line?: number } }
    return { serviceOwners, error: `YAML: ${ye.reason ?? 'parse error'}${ye.mark?.line !== undefined ? ` at line ${ye.mark.line + 1}` : ''}` }
  }
}

function short(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 120)
}
