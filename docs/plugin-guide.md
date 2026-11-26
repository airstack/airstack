# Plugin Development Guide

Guidelines for creating and modifying stack-cli plugins.

## Plugin Structure

```
cli/plugins/{name}/
  index.ts          — Plugin registration (register function, commands, report)
  hooks/            — Deploy phase hooks (one file per hook)
    pre-stage.ts    — Config enrichment + defaults
    stage.ts        — Template rendering + artifact generation
    pre-sync.ts     — Change detection (hash comparison, registry checks)
    post-sync.ts    — Post-rsync fixups (permissions, file moves)
    build.ts        — Image builds, compilation
    validate.ts     — Post-deploy validation
  lib/              — Shared utilities (config parsing, status checking)
  commands/         — CLI subcommands (if plugin has its own command tree)
  deploy/           — Files deployed to VPS via rsync (scripts, configs)
  docker/           — Dockerfile templates (NOT deployed, used as build inputs)
  crons/            — Cron script shims/templates
  templates/        — Handlebars templates registered for stage processing
```

## Core Conventions

### 1. Config Enrichment happens in pre-stage ONLY

All modifications to `ctx.config` must happen during the pre-stage hook. This ensures `stack-cli env context` shows the fully enriched config.

```typescript
// ✅ CORRECT: enrich in pre-stage
async function preStageHook(ctx: DeployContext): Promise<void> {
  const plugin = (ctx.config.plugins.myPlugin || {}) as Record<string, unknown>
  plugin.resolvedPath = computePath(ctx.config.stack.installDir)
  ctx.config.plugins.myPlugin = plugin
}

// ❌ WRONG: enrich in stage or later
async function stageHook(ctx: DeployContext): Promise<void> {
  ctx.config.plugins.myPlugin.computedValue = 'too late'  // won't show in env context
}
```

### 2. Plugin config lives under `plugins.{name}`

```yaml
# stack.yml
plugins:
  myPlugin:
    someKey: value
```

Access in code: `ctx.config.plugins.myPlugin`

### 3. Stack services enriched when deterministic

When a plugin manages a specific stack service (e.g., an `apps` plugin manages `stack.apps`), it can enrich that service's config during pre-stage:

```typescript
// apps plugin enriches stack.apps with derived values
const apps = (ctx.config.stack as any).apps
for (const [name, app] of Object.entries(apps)) {
  app.containerName = `${projectName}-app-${name}`
  app.imageTag = `app-${projectName}:${version}`
}
```

### 4. Template context = enriched Config

Templates receive the Config object directly. No separate `templateContext` bag.

```handlebars
{{! Access config paths directly }}
{{stack.projectName}}
{{stack.installDir}}
{{plugins.apps.dataDir}}
{{#each stack.apps}}
  {{this.containerName}}
{{/each}}
```

### 5. Use `ctx.updateConfig()` for persisting generated values

When generating non-deterministic values (tokens, keys), always use `ctx.updateConfig()`:

```typescript
// ✅ CORRECT
ctx.updateConfig('stack.apps.myApp.apiToken', generatedToken)

// ❌ WRONG: mutating config directly doesn't persist to stack.yml
ctx.config.stack.apps.myApp.apiToken = generatedToken
```

### 6. Never read from `.env` directly

All config comes through `ctx.config` (loaded from stack.yml with `${VAR}` resolution from .env). Plugins must never:

- Read `.env` files directly
- Use `process.env` for config values
- Write to `.env` files

```typescript
// ✅ CORRECT: read from config
const token = String(ctx.config.plugins.cloudflare.apiToken || '')

// ❌ WRONG: read from .env or process.env
const token = process.env.CLOUDFLARE_API_TOKEN
```

### 7. Defaults via `<<+` in stack.yml

Use the `<<+` deep merge syntax for config defaults:

```yaml
stack:
  apps:
    $defaults:
      timezone: America/Los_Angeles
      dashboardPath: /dashboard
    my-app:
      <<+: $defaults
      domain: app.example.com
```

Plugins strip special keys (like `$defaults`) during pre-stage.

### 8. Registered files for permission checks and orphan cleanup

Plugins register their deployed scripts and host files during pre-stage:

```typescript
// Register host files for orphan detection
ctx.registeredFiles.hostFiles.push(`/etc/cron.d/${projectName}_myCron`)

// Register script excludes (sourced libraries, not directly executed)
ctx.registeredFiles.scripts.exclude.push('plugins/myPlugin/lib/helpers.sh')
```

## Anti-Patterns

### Don't use `ctx.templateContext`

Removed. Templates use `ctx.config` directly.

### Don't hardcode paths

Use `ctx.config.stack.installDir` and `ctx.config.plugins.{name}.dataDir`.

### Don't skip shell quoting

All values interpolated into remote shell commands must be quoted:

```typescript
const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`
await ctx.remote.run(`sudo bash script.sh ${q(name)} ${q(value)}`)
```

### Don't write deploy artifacts outside `.deploy/`

Stage hooks write to `ctx.deployDir`. Everything in `.deploy/` gets rsync'd to VPS.

### Don't modify Config after pre-stage

Later hooks should read Config, not write to it.

## Logging Conventions

Use `ctx.log` with a consistent plugin name prefix:

```typescript
ctx.log.info(`[myPlugin] Staged 3 config files`)
ctx.log.warn(`[myPlugin] Missing optional config: fallback used`)
ctx.log.error(`[myPlugin] Build failed for image: ${name}`)
```

Log these events:
- Config enrichment (what defaults were applied)
- `updateConfig` calls (what was generated/persisted)
- File staging (what was rendered/copied)
- Remote commands (already logged by the SSH executor)
- Build triggers and results
- Validation findings

## Hook Phases Reference

| Phase | Purpose | Typical Plugin Work |
|-------|---------|-------------------|
| **pre-stage** | Enrich config, register files | Inject defaults, generate tokens, resolve paths |
| **stage** | Build `.deploy/` artifacts | Render Dockerfiles, generate configs, copy scripts |
| **pre-sync** | Change detection | Compare hashes, check registry, detect drift |
| **sync** | (core only) | rsync `.deploy/` to VPS |
| **post-sync** | Post-rsync fixups | Fix permissions, sync extra files, move `/etc/` configs |
| **build** | Build images | Docker builds, sandbox image builds |
| **pre-start** | Pre-start prep | Create networks, verify prerequisites |
| **dry-run** | (core only) | Validate compose config |
| **start** | (core only) | Docker compose up |
| **healthcheck** | Health verification | Poll container health |
| **post-deploy** | Post-start tasks | Register crons, trigger background jobs |
| **validate** | Final verification | Check build status, scan logs, verify configs |

## Plugin Registration

```typescript
export function register(_config: unknown): Plugin {
  return {
    name: 'myPlugin',
    commands: {
      'my-command': {
        description: 'Do something',
        run: myCommandHandler,
      },
    },
    report: {
      title: 'My Plugin',
      order: 30,
      template: '{{#if myPlugin.data}}...{{/if}}',
    },
    hooks: {
      'pre-stage': preStageHook,
      stage: stageHook,
      validate: validateHook,
    },
  }
}
```

## Testing

- Test hooks with mock `DeployContext` (see `test/cli/helpers.ts`)
- Test pure functions (config parsing, hash computation) independently
- Use `setupProject()` to create temp stack.yml + .env for integration tests
- Verify enrichment shows in `env context` output
