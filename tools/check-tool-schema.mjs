#!/usr/bin/env node
/**
 * Verify the agent tool definition against the Harness registry's real schema check.
 *
 * The tool definition is written structurally (see
 * `packages/speechrail-input/src/host/tools.ts`) because importing
 * `@deepseek-ai/dsh-tools` declarations pulls `@deepseek-ai/dsh-llm` into the
 * Typert-analyzed program and breaks generation. That means the compiler cannot
 * check the schema against the registry, and an unsupported keyword would only
 * surface at runtime as a tool that never registers.
 *
 * This script closes that gap. It runs inside `pnpm verify` as `--optional`: when the
 * package resolves (any machine with the Harness installed) the real registry check
 * runs, and when it does not, the run prints that it skipped instead of failing -
 * nothing is enforced silently. Without `--optional` an unresolvable package is a
 * failure, which is what a manual check wants.
 *
 *   pnpm --filter @hrygo/dsh-speechrail-bundle add -D @deepseek-ai/dsh-tools@0.2.1-rc.2
 *   pnpm --filter @hrygo/dsh-speechrail-bundle run build:host
 *   node tools/check-tool-schema.mjs
 *   pnpm --filter @hrygo/dsh-speechrail-bundle remove @deepseek-ai/dsh-tools
 *
 * When the package is not resolvable from the workspace at all, point the script at
 * any copy of it, including one still in the pnpm store:
 *
 *   node tools/check-tool-schema.mjs <path to the package directory itself>
 * (a copy usually survives at node_modules/.pnpm/@deepseek-ai+dsh-tools@<version>-<hash>/node_modules/@deepseek-ai/dsh-tools)
 *
 * The install must not be left in place: generation fails while it is.
 */

import { pathToFileURL } from 'node:url'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Structural equality with sorted keys, so key order cannot matter. */
function same(left, right) {
  const normalize = (value) => {
    if (Array.isArray(value)) return value.map(normalize)
    if (typeof value !== 'object' || value === null) return value
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])]))
  }
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right))
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const built = join(root, 'packages/speechrail-input/lib/types/host/tools.js')

if (!existsSync(built)) {
  console.error(`check-tool-schema: ${built} is missing; run the host build first`)
  process.exit(2)
}

// `--optional` makes an unresolvable package a printed skip instead of a failure, so this can run
// inside `pnpm verify` (which must pass on a machine that never installed the Harness) while the
// machines that do have the package - the release machine - still check the real registry.
const optional = process.argv.includes('--optional')
/** The version part of a store directory name, or an empty string when it has none. */
function versionOf(directoryName) {
  return directoryName.slice('@deepseek-ai+dsh-tools@'.length).split('_')[0]
}

/** Compare two dotted version strings numerically, ignoring any suffix. */
function compareVersions(left, right) {
  const parts = (value) => value.split('-')[0].split('.').map((part) => Number.parseInt(part, 10) || 0)
  const a = parts(left)
  const b = parts(right)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

/** Copies of the package that sit in this workspace's store without being importable by name. */
function storedCopies() {
  const store = join(root, 'node_modules/.pnpm')
  if (!existsSync(store)) return []
  return readdirSync(store)
    .filter((entry) => entry.startsWith('@deepseek-ai+dsh-tools@'))
    // Newest first, by number rather than by string: '0.9.0' sorts above '0.10.0' lexically, which
    // would quietly check the wrong copy.
    .sort((left, right) => compareVersions(versionOf(right), versionOf(left)))
    .map((entry) => join(store, entry, 'node_modules/@deepseek-ai/dsh-tools/lib/index.js'))
    .filter((candidate) => existsSync(candidate))
}

const override = process.argv.slice(2).find((argument) => argument !== '--optional')
const candidates = override === undefined
  ? ['@deepseek-ai/dsh-tools', ...storedCopies().map((path) => pathToFileURL(path).href)]
  : [pathToFileURL(join(resolve(override), 'lib/index.js')).href]
let assertion
let compile
let loadedFrom = ''
let loadError = null
for (const specifier of candidates) {
  try {
    // Deliberately not the `({ name } = await import(x))` form: inside this module's
    // top-level await, that form throws a spurious "Cannot access 'specifier' before
    // initialization" on Node 26.
    const loaded = await import(specifier)
    assertion = loaded.assertSupportedJsonSchema
    compile = loaded.defineTool
    const resolved = specifier.startsWith('file:') ? specifier.slice(5) : import.meta.resolve(specifier)
    loadedFrom = resolved.startsWith('file:') ? resolved.slice(5) : resolved
    loadError = null
    break
  } catch (error) {
    loadError = error
  }
}
if (loadError !== null) {
  if (optional) {
    // Upper case so a clean CI runner cannot look like a check that ran and passed.
    console.log(`check-tool-schema: SKIPPED - no @deepseek-ai/dsh-tools resolvable (${loadError.message})`)
    process.exit(0)
  }
  console.error(`check-tool-schema: cannot load @deepseek-ai/dsh-tools (${loadError.message}); see the header of this file`)
  process.exit(2)
}

/** Version of the package that was actually checked, when it can be read. */
function checkedVersion(entryPath) {
  let directory = dirname(entryPath)
  for (let depth = 0; depth < 4; depth += 1) {
    const manifestPath = join(directory, 'package.json')
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
        if (typeof manifest.version === 'string' && typeof manifest.name === 'string' && manifest.name === '@deepseek-ai/dsh-tools') {
          return `${manifest.name}@${manifest.version}`
        }
      } catch {
        // A manifest that cannot be read only costs the version in the report.
      }
    }
    directory = dirname(directory)
  }
  return '@deepseek-ai/dsh-tools (version unreadable)'
}

const { createStatusTool } = await import(pathToFileURL(built).href)
const definition = createStatusTool({ status: async () => ({}), check: async () => ({}) })
const failures = []

try {
  assertion(definition.output.schema)
} catch (error) {
  failures.push(`output.schema: ${error.message}`)
}

const properties = definition.output.schema.properties ?? {}
const required = definition.output.schema.required ?? []
for (const [name, property] of Object.entries(properties)) {
  if ('required' in property) failures.push(`${name}: requiredness must live in the top-level array, not on the property`)
  if (!required.includes(name)) failures.push(`${name}: missing from the top-level required array`)
}
for (const name of required) {
  if (!(name in properties)) failures.push(`${name}: required but not declared`)
}
if (definition.parameters.type !== 'object') failures.push('parameters: root must be an object')

// The hand-written shapes must equal what `defineTool` compiles to, because that is
// what a plugin written the ordinary way would expose; the registry's assertion alone
// would accept a shape the model-facing contract does not match.
const spec = {
  name: definition.name,
  description: definition.description,
  // `probe` is optional, so its spec entry carries no `required`: that is how the
  // spec dialect keeps a property out of the compiled top-level `required` array.
  parameters: Object.fromEntries(Object.entries(definition.parameters.properties).map(([name, property]) => [name, { ...property }])),
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: Object.fromEntries(Object.entries(properties).map(([name, property]) => [name, { ...property, required: true }])),
    },
  },
}
const compiled = compile(spec)
if (!same(compiled.parameters, definition.parameters)) failures.push(`parameters differ from compiled output: ${JSON.stringify(compiled.parameters)}`)
if (!same(compiled.output.schema, definition.output.schema)) failures.push(`output.schema differs from compiled output: ${JSON.stringify(compiled.output.schema)}`)

if (failures.length > 0) {
  console.error(`check-tool-schema: ${definition.name} would not register:`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}

console.log(`check-tool-schema: ${definition.name} matches ${checkedVersion(loadedFrom)} via defineTool's compiled shapes and is accepted by the registry assertion (${Object.keys(properties).length} output fields)`)
