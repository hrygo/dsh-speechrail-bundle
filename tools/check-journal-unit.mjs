#!/usr/bin/env node
/**
 * Assert that the journal's storage unit name satisfies the real backend rule.
 *
 * The storage backend validates unit names against `/^[a-z][a-z0-9_]*$/`. A name that
 * breaks it makes `kv.open()` reject the descriptor, and because the plugin treats an
 * unopenable journal as "an earlier upload's outcome is unproven", every upload is
 * refused and the gate can never be cleared — a silent, total failure of the feature.
 *
 * The unit tests cannot catch this on their own: they drive `journalFromUnit` over
 * doubles, and importing the storage package into the type-checked program is not
 * possible here. This script closes the gap against the real rule.
 *
 *   node tools/check-journal-unit.mjs      # run after `pnpm build:host`
 */

import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const built = join(root, 'packages/speechrail-input/lib/types/host/journal.js')

if (!existsSync(built)) {
  console.error(`check-journal-unit: ${built} is missing; run the host build first`)
  process.exit(2)
}

let unitNameRe
try {
  ({ UNIT_NAME_RE: unitNameRe } = await import('@deepseek-ai/dsh-storage'))
} catch {
  // The dependency belongs to the workspace package, so resolve it from there.
  const fromPackage = join(root, 'packages/speechrail-input/node_modules/@deepseek-ai/dsh-storage/lib/index.js')
  try {
    ({ UNIT_NAME_RE: unitNameRe } = await import(pathToFileURL(fromPackage).href))
  } catch (error) {
    console.error(`check-journal-unit: cannot load @deepseek-ai/dsh-storage (${error.message})`)
    process.exit(2)
  }
}

const { JOURNAL_UNIT, JOURNAL_VERSION } = await import(pathToFileURL(built).href)
const problems = []
if (!unitNameRe.test(JOURNAL_UNIT)) problems.push(`JOURNAL_UNIT ${JSON.stringify(JOURNAL_UNIT)} does not match ${unitNameRe}`)
if (!Number.isInteger(JOURNAL_VERSION) || JOURNAL_VERSION < 1) problems.push(`JOURNAL_VERSION ${String(JOURNAL_VERSION)} is not a positive integer`)

if (problems.length > 0) {
  console.error('check-journal-unit: the journal could never open:')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

console.log(`check-journal-unit: ${JOURNAL_UNIT} (version ${JOURNAL_VERSION}) is accepted by ${unitNameRe}`)
