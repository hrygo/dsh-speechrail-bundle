#!/usr/bin/env node
/**
 * Generate this workspace's Typert reflection artifacts.
 *
 * Why this exists as a script instead of only the tsdown plugin: the client face
 * imports this same package's generated `./remote` contribution, so the artifact
 * must exist before the workspace can be typechecked in one pass. The generator's
 * own per-package diagnostic pass is therefore skipped here and repeated by
 * `pnpm typecheck` (tsc) and again by the tsdown plugin during `pnpm build:host`.
 *
 * @module dsh-speechrail-bundle/scripts/generate-typert
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { findWorkspaceRoot, WorkspaceTypertGenerator, writeWorkspaceArtifacts } from '@deepseek-ai/dsh-typert-generator'

const PACKAGE_DIR = 'packages/voice-input'
const PACKAGE_NAME = 'dsh-voice-input'
const skipDiagnostics = process.argv.includes('--skip-diagnostics')

const root = findWorkspaceRoot(process.cwd())
if (root === undefined) throw new Error('generate-typert: no workspace root with tsconfig.host.json and packages/ was found')

const generator = new WorkspaceTypertGenerator(root, { checkDiagnostics: !skipDiagnostics })
const artifacts = generator.generateContributors()
if (artifacts.length === 0) throw new Error(`generate-typert: no Typert contributor was discovered under ${root}`)
writeWorkspaceArtifacts(root, artifacts)

const emitted = artifacts.filter((artifact) => artifact.package === PACKAGE_NAME)
if (emitted.length === 0) throw new Error(`generate-typert: ${PACKAGE_NAME} produced no artifact`)

const files = [
  'lib/typert.host.js',
  'lib/typert.host.d.ts',
  'lib/typert.remote-client.js',
  'lib/typert.remote-client.d.ts',
]
for (const file of files) {
  const path = join(root, PACKAGE_DIR, file)
  if (!existsSync(path)) throw new Error(`generate-typert: ${PACKAGE_NAME} did not emit ${file}`)
}
// The host artifact is executable reflection: its declarations file is a placeholder,
// so the namespace and endpoint ids are asserted against the JavaScript it emits.
const host = readFileSync(join(root, PACKAGE_DIR, 'lib/typert.host.js'), 'utf8')
const remote = readFileSync(join(root, PACKAGE_DIR, 'lib/typert.remote-client.d.ts'), 'utf8')
for (const endpoint of ['speechrailInput/status', 'speechrailInput/check', 'speechrailInput/configure', 'speechrailInput/transcribe', 'speechrailInput/acknowledgeUnknown']) {
  if (!host.includes(endpoint)) throw new Error(`generate-typert: the host artifact is missing ${endpoint}`)
}
if (!remote.includes('TypertRemoteNamespaceMap') || !remote.includes("'speechrailInput'")) {
  throw new Error('generate-typert: the Remote artifact does not declare the speechrailInput namespace')
}

const shapes = emitted.map((artifact) => `${artifact.face}${artifact.remote === undefined ? '' : '+remote'}`).sort()
process.stdout.write(`generate-typert: ${PACKAGE_NAME} (${shapes.join(', ')}), diagnostics ${skipDiagnostics ? 'skipped (tsc owns this gate)' : 'checked'}\n`)
