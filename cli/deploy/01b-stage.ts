/**
 * Phase 01b: Stage
 *
 * Core: build .deploy/ directory from deploy/ base + templates + plugin templates.
 *
 * Template context is built from the enriched Config (host, stack, plugins, deploy)
 * plus the manifest (generated during stage, not part of Config).
 */

import { existsSync, statSync, cpSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import Handlebars from 'handlebars'
import type { DeployContext } from '../types.js'
import { stage as runStage } from '../lib/stage.js'
import { processTemplates } from '../lib/template-engine.js'

export async function stage(ctx: DeployContext): Promise<void> {
  const errors: string[] = []

  // Template context is the enriched Config + manifest
  const templateContext: Record<string, unknown> = {
    host: ctx.config.host,
    stack: ctx.config.stack,
    plugins: ctx.config.plugins,
    deploy: ctx.config.deploy,
    manifest: ctx.manifest,
    compose: {},
  }

  // 0. Render plugin compose services (after enrichment, before docker-compose.yml.hbs)
  const pluginServiceBlocks: string[] = []
  for (const plugin of ctx.plugins) {
    if (!plugin.composeServices?.length) continue
    for (const svc of plugin.composeServices) {
      const tmplPath = join(plugin.sourceDir!, svc.template)
      if (!existsSync(tmplPath)) {
        errors.push(`[${plugin.name}] Compose service template not found: ${tmplPath}`)
        continue
      }
      const tmplSrc = readFileSync(tmplPath, 'utf-8')
      const tmpl = Handlebars.compile(tmplSrc, { noEscape: true })
      pluginServiceBlocks.push(tmpl(templateContext))
    }
  }
  ;(templateContext.compose as Record<string, unknown>).pluginServices = pluginServiceBlocks.join('\n')

  // 1. Core staging with config-based context
  runStage({
    projectRoot: ctx.projectRoot,
    sharedPaths: ctx.sharedPaths,
    config: ctx.config,
    deployDir: ctx.deployDir,
    extraContext: templateContext,
    errors,
    manifestEntries: ctx.manifest.entries,
  })

  // 2. Process plugin-registered templates
  for (const plugin of ctx.plugins) {
    if (plugin.templates && Object.keys(plugin.templates).length > 0) {
      const searchPaths = plugin.sourceDir
        ? [plugin.sourceDir, ...ctx.sharedPaths]
        : ctx.sharedPaths
      processTemplates(
        plugin.templates,
        templateContext,
        ctx.projectRoot,
        searchPaths,
        ctx.deployDir,
        errors,
      )
    }
  }

  // 3. Auto-stage plugin deploy/ directories
  for (const plugin of ctx.plugins) {
    const deploySource = plugin.deploySourceDir
      ?? (plugin.sourceDir ? join(plugin.sourceDir, 'deploy') : undefined)
    if (deploySource && existsSync(deploySource) && statSync(deploySource).isDirectory()) {
      const dest = join(ctx.deployDir, 'plugins', plugin.name)
      const skip = new Set((plugin.deployExclude ?? []).map((e) => join(deploySource, e)))
      cpSync(deploySource, dest, { recursive: true, filter: (src) => !skip.has(src) })
    }
  }

  for (const err of errors) {
    ctx.errors.push({ phase: 'stage', message: err, fatal: true })
  }

  if (errors.length === 0) {
    ctx.phaseStatus.push({ phase: 'stage', success: true, message: 'Staged .deploy/' })
  } else {
    ctx.phaseStatus.push({ phase: 'stage', success: false, message: `Staging failed: ${errors.length} error(s)` })
  }
}
