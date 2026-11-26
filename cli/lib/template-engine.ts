import Handlebars from 'handlebars'
import { readFileSync, writeFileSync, mkdirSync, cpSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveFile } from './resolve-file'

/**
 * Process the `templates:` section from stack.yml.
 * For each entry:
 *   - Resolve the source file via resolveFile (projectRoot first, then sharedPaths)
 *   - If source ends with .hbs: render with Handlebars and write to destination in deployDir
 *   - Otherwise: copy as-is to destination in deployDir
 * Destination paths may contain {{}} expressions, rendered with Handlebars against context.
 * Missing source files push an error to the errors array (do not throw).
 */
export function processTemplates(
  templates: Record<string, { src: string }>,
  context: Record<string, unknown>,
  projectRoot: string,
  sharedPaths: string[],
  deployDir: string,
  errors?: string[],
): void {
  for (const [destRelative, entry] of Object.entries(templates)) {
    // Render destination path with Handlebars (supports {{}} expressions)
    const destPath = join(deployDir, Handlebars.compile(destRelative, { noEscape: true })(context))

    // Resolve source file
    let srcPath: string
    try {
      srcPath = resolveFile(projectRoot, sharedPaths, entry.src)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (errors) {
        errors.push(message)
      }
      continue
    }

    // Ensure destination directory exists
    mkdirSync(dirname(destPath), { recursive: true })

    if (entry.src.endsWith('.hbs')) {
      // Render template with Handlebars
      const templateSource = readFileSync(srcPath, 'utf8')
      const compiled = Handlebars.compile(templateSource, { noEscape: true })
      const rendered = compiled(context)
      writeFileSync(destPath, rendered, 'utf8')
    } else {
      // Copy as-is
      cpSync(srcPath, destPath)
    }
  }
}
