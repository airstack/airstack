import { describe, it, expect } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { loadPlugins } from '../../../cli/lib/plugin-loader'
import { makeTmpDir } from '../helpers'

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Create a minimal plugin module file in a directory.
 * Returns the path to the plugin directory.
 */
function createPluginDir(baseDir: string, name: string, registerBody = ''): string {
  const pluginDir = join(baseDir, 'plugins', name)
  mkdirSync(pluginDir, { recursive: true })
  writeFileSync(
    join(pluginDir, 'index.ts'),
    `export function register(config) {
      return {
        name: '${name}',
        ${registerBody}
      }
    }`,
  )
  return pluginDir
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('loadPlugins', () => {
  it('returns empty array for empty config', async () => {
    const root = makeTmpDir()
    const plugins = await loadPlugins({}, root, [])

    expect(plugins).toEqual([])
  })

  it('returns plugins in declaration order', async () => {
    const root = makeTmpDir()
    createPluginDir(root, 'alpha')
    createPluginDir(root, 'beta')
    createPluginDir(root, 'gamma')

    const plugins = await loadPlugins(
      { alpha: {}, beta: {}, gamma: {} },
      root,
      [],
    )

    expect(plugins.map(p => p.name)).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('calls register() with plugin config', async () => {
    const root = makeTmpDir()
    const pluginDir = join(root, 'plugins', 'my-plugin')
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(
      join(pluginDir, 'index.ts'),
      `export function register(config) {
        return {
          name: 'my-plugin',
          dataDir: '/data/' + config.port,
        }
      }`,
    )

    const cfg = { enabled: true, port: 3000 }
    const plugins = await loadPlugins({ 'my-plugin': cfg }, root, [])

    expect(plugins).toHaveLength(1)
    expect(plugins[0].dataDir).toBe('/data/3000')
  })

  it('sets plugin name from the config key (overrides register return)', async () => {
    const root = makeTmpDir()
    const pluginDir = join(root, 'plugins', 'renamed')
    mkdirSync(pluginDir, { recursive: true })
    // The register function returns a different name — loadPlugin should override it
    writeFileSync(
      join(pluginDir, 'index.ts'),
      `export function register(config) {
        return { name: 'original-name' }
      }`,
    )

    const plugins = await loadPlugins({ renamed: {} }, root, [])

    expect(plugins).toHaveLength(1)
    expect(plugins[0].name).toBe('renamed')
  })

  it('handles missing plugin gracefully (returns null, filtered out)', async () => {
    const root = makeTmpDir()
    // Don't create any plugin files

    const plugins = await loadPlugins({ 'nonexistent': {} }, root, [])

    expect(plugins).toEqual([])
  })

  it('loads plugins from sharedPaths when not in projectRoot', async () => {
    const root = makeTmpDir()
    const shared = makeTmpDir()
    createPluginDir(shared, 'shared-plugin')

    const plugins = await loadPlugins({ 'shared-plugin': {} }, root, [shared])

    expect(plugins).toHaveLength(1)
    expect(plugins[0].name).toBe('shared-plugin')
  })

  it('prefers projectRoot plugin over sharedPaths plugin', async () => {
    const root = makeTmpDir()
    const shared = makeTmpDir()

    // Create in both locations with different dataDir to distinguish
    const rootPluginDir = join(root, 'plugins', 'duptest')
    mkdirSync(rootPluginDir, { recursive: true })
    writeFileSync(
      join(rootPluginDir, 'index.ts'),
      `export function register(config) {
        return { name: 'duptest', dataDir: '/from-root' }
      }`,
    )

    const sharedPluginDir = join(shared, 'plugins', 'duptest')
    mkdirSync(sharedPluginDir, { recursive: true })
    writeFileSync(
      join(sharedPluginDir, 'index.ts'),
      `export function register(config) {
        return { name: 'duptest', dataDir: '/from-shared' }
      }`,
    )

    const plugins = await loadPlugins({ duptest: {} }, root, [shared])

    expect(plugins).toHaveLength(1)
    expect(plugins[0].dataDir).toBe('/from-root')
  })

  it('loads built-in plugins from cli/plugins/', async () => {
    // The 'cron' plugin is a built-in plugin — test that it loads
    const root = makeTmpDir()
    const plugins = await loadPlugins({ cron: null }, root, [])

    expect(plugins).toHaveLength(1)
    expect(plugins[0].name).toBe('cron')
    // cron plugin should have hooks
    expect(plugins[0].hooks).toBeDefined()
  })

  it('built-in plugin takes priority over project-level plugin with same name', async () => {
    const root = makeTmpDir()
    // Create a project-level plugin with the same name as a built-in
    const projectPluginDir = join(root, 'plugins', 'cron')
    mkdirSync(projectPluginDir, { recursive: true })
    writeFileSync(
      join(projectPluginDir, 'index.ts'),
      `export function register(config) {
        return { name: 'cron', dataDir: '/from-project' }
      }`,
    )

    const plugins = await loadPlugins({ cron: null }, root, [])

    expect(plugins).toHaveLength(1)
    expect(plugins[0].name).toBe('cron')
    // Should be the built-in (has hooks), not the project-level one
    expect(plugins[0].hooks).toBeDefined()
  })

  it('skips plugins that are not found and still loads found ones', async () => {
    const root = makeTmpDir()
    createPluginDir(root, 'real-plugin')

    const plugins = await loadPlugins(
      { missing: {}, 'real-plugin': {}, also_missing: {} },
      root,
      [],
    )

    expect(plugins).toHaveLength(1)
    expect(plugins[0].name).toBe('real-plugin')
  })

  it('throws when plugin module does not export register()', async () => {
    const root = makeTmpDir()
    const pluginDir = join(root, 'plugins', 'bad-plugin')
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(
      join(pluginDir, 'index.ts'),
      `export const name = 'bad-plugin'`,  // no register function
    )

    await expect(loadPlugins({ 'bad-plugin': {} }, root, [])).rejects.toThrow(
      'does not export register()',
    )
  })

  it('sets sourceDir on loaded plugins to the directory containing index.ts', async () => {
    const root = makeTmpDir()
    try {
      mkdirSync(join(root, 'plugins', 'testplug'), { recursive: true })
      writeFileSync(join(root, 'plugins', 'testplug', 'index.ts'),
        'export function register() { return { name: "testplug" } }')

      const plugins = await loadPlugins({ testplug: {} }, root, [])
      expect(plugins).toHaveLength(1)
      expect(plugins[0].sourceDir).toBe(join(root, 'plugins', 'testplug'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
