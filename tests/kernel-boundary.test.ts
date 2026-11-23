import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Episteme is the kernel; applications build on it and pass in their own scene (ADR 0013, ADR 0019). The kernel's
 * source may not reach for an application or carry an application's scene, so a dependency in that direction fails
 * here rather than in review.
 */

const ROOT = resolve(import.meta.dirname, '..')
const KERNEL_SOURCES = ['packages', 'apps/service/src']

/** What only an application may name: its packages, and the Learn scene that #101 took out of the kernel. */
const FORBIDDEN: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  { pattern: /from '@mindlink\//u, why: 'imports a MindLink package' },
  { pattern: /from '@episteme\/(workbench|domain-learn)'/u, why: 'imports an application package' },
  {
    pattern: /\b(learnScene|learnProfile|LearnSession|learnEvaluationPolicy)\b/u,
    why: 'names the Learn scene',
  },
]

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name === 'dist') return []
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.ts$/u.test(entry.name) && !entry.name.endsWith('.d.ts') ? [path] : []
  })
}

describe('the kernel boundary', () => {
  it('keeps every application and its scene out of the kernel source', () => {
    const found: string[] = []
    for (const root of KERNEL_SOURCES) {
      for (const file of sourceFiles(join(ROOT, root))) {
        const text = readFileSync(file, 'utf8')
        for (const { pattern, why } of FORBIDDEN) {
          if (pattern.test(text)) found.push(`${relative(ROOT, file)}: ${why}`)
        }
      }
    }
    expect(found).toEqual([])
  })
})
