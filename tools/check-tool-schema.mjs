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
 * This script closes that gap. It needs the package available, which is why it is
 * not part of `pnpm verify`:
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
import { existsSync } from 'node:fs'
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

const override = process.argv[2]
let assertion
let compile
try {
  const specifier = override === undefined ? '@deepseek-ai/dsh-tools' : pathToFileURL(join(resolve(override), 'lib/index.js')).href
  // Deliberately not the `({ name } = await import(x))` form: inside this module's
  // top-level await, that form throws a spurious "Cannot access 'specifier' before
  // initialization" on Node 26.
  const loaded = await import(specifier)
  assertion = loaded.assertSupportedJsonSchema
  compile = loaded.defineTool
} catch (error) {
  console.error(`check-tool-schema: cannot load @deepseek-ai/dsh-tools (${error.message}); see the header of this file`)
  process.exit(2)
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

console.log(`check-tool-schema: ${definition.name} matches defineTool's compiled shapes and is accepted by the registry assertion (${Object.keys(properties).length} output fields)`)
