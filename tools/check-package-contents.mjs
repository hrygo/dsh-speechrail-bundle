#!/usr/bin/env node
/**
 * Assert that everything the manifest points at is actually in the packed tarball.
 *
 * `files` decides what npm publishes, and the manifest's entry points (`main`, `types`, `exports`,
 * `dsh.bundle.patch`) decide what the Harness loads at install time. When a new build output is added
 * but not added to `files`, or a `files` pattern stops matching because a path moved, the tarball
 * still publishes cleanly and still installs - it just fails later, in someone else's profile, with a
 * missing module. Nothing else in the pipeline compares the two lists.
 *
 *   pnpm --filter <package> run build        # the packed lib/ must exist first
 *   node tools/check-package-contents.mjs
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packagesDir = join(root, 'packages')

// Without a build every entry point looks missing, which would report the whole manifest as broken
// instead of saying what is actually wrong.
if (!existsSync(join(root, 'packages/voice-input/lib/index.js'))) {
  console.error('check-package-contents: packages/voice-input/lib is missing; run the build first')
  process.exit(2)
}

/** Turn one npm `files`-style pattern into an anchored regular expression. */
function globToRegExp(pattern) {
  let source = '^'
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        // `**/` also matches nothing at all, so `lib/**/*.d.ts` covers `lib/a.d.ts`.
        if (pattern[index + 2] === '/') { source += '(?:.*/)?'; index += 2 } else { source += '.*'; index += 1 }
      } else {
        source += '[^/]*'
      }
    } else if (character === '?') {
      source += '[^/]'
    } else {
      source += character.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    }
  }
  return new RegExp(`${source}$`, 'u')
}

/** Every file reference in the manifest, with the field that names it. */
function manifestReferences(manifest) {
  const found = []
  for (const field of ['main', 'types', 'unpkg']) {
    const value = manifest[field]
    if (typeof value === 'string' && value.startsWith('./')) found.push({ field, value })
  }
  const walk = (node, path) => {
    if (typeof node === 'string') {
      if (node.startsWith('./')) found.push({ field: `exports${path}`, value: node })
      return
    }
    if (typeof node !== 'object' || node === null) return
    for (const [key, child] of Object.entries(node)) walk(child, `${path}.${key}`)
  }
  walk(manifest.exports, '')
  const patch = manifest.dsh?.bundle?.patch
  if (typeof patch === 'string') found.push({ field: 'dsh.bundle.patch', value: patch })
  return found
}

/** What `npm pack` would actually put in the tarball for one package directory. */
function packedPaths(directory) {
  const packed = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: directory, encoding: 'utf8' })
  if (packed.status !== 0) {
    throw new Error(`npm pack --dry-run failed in ${directory}: ${packed.stderr.trim()}`)
  }
  const parsed = JSON.parse(packed.stdout)
  // npm 12 keys the report by package name; older npm returns an array of the same objects.
  const entry = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0]
  return (entry?.files ?? []).map((file) => file.path)
}

const problems = []
let checked = 0
let globs = 0
const packages = readdirSync(packagesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(packagesDir, entry.name, 'package.json')))
  .map((entry) => ({ name: entry.name, directory: join(packagesDir, entry.name) }))

for (const bundle of packages) {
  const manifest = JSON.parse(readFileSync(join(bundle.directory, 'package.json'), 'utf8'))
  if (manifest.dsh === undefined || manifest.dsh === null) continue
  const packed = packedPaths(bundle.directory)
  const matches = (pattern) => packed.some((path) => globToRegExp(pattern).test(path))

  // 1. Every entry point the manifest promises must survive packing.
  for (const reference of manifestReferences(manifest)) {
    checked += 1
    const pattern = reference.value.slice(2)
    if (!matches(pattern)) {
      problems.push(`${manifest.name}: ${reference.field} points at ${reference.value}, which npm would not pack`)
    }
  }

  // 2. Every declared pattern must match something, or it is dead weight that hides a rename.
  for (const pattern of manifest.files ?? []) {
    if (/[*?]/u.test(pattern)) globs += 1
    if (!matches(pattern)) {
      problems.push(`${manifest.name}: files entry "${pattern}" matches nothing npm would pack`)
    }
  }
}

if (problems.length > 0) {
  console.error('check-package-contents: the published package would be incomplete:')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

console.log(`check-package-contents: ${String(checked)} manifest reference(s) and ${String(globs)} glob(s) are covered by what npm packs`)
