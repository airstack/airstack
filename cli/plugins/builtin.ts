/**
 * builtin.ts — the built-in plugins, imported statically.
 *
 * A compiled binary cannot import its own TypeScript from disk at run time in a stable way, so the
 * core loads `airstack/<name>` plugins from this table. Their asset dirs (templates/, deploy/,
 * crons/) still come from disk under the core root (see lib/core.ts). Fleet plugins are imported
 * from the fleet repo at run time (lib/fleet-check.ts).
 */

import type { Plugin } from '../types.js'
import * as backup from './backup/index.js'
import * as cliproxyapi from './cliproxyapi/index.js'
import * as cloudflare from './cloudflare/index.js'
import * as cron from './cron/index.js'
import * as tailscale from './tailscale/index.js'

export interface PluginModule {
  register: (config: unknown) => Plugin
}

export const BUILTIN_PLUGINS: Record<string, PluginModule> = { backup, cliproxyapi, cloudflare, cron, tailscale }
