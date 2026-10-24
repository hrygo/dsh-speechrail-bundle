#!/usr/bin/env node
/**
 * Assert that the version, the tag and the documented install URL all agree.
 *
 * A release is published by hand: the version is bumped, the install URL in each README is
 * repointed at the new tag, an annotated tag is pushed, the tarball is packed and attached to a
 * GitHub release. Three independent edits have to agree, and nothing else in the pipeline notices
 * when one of them is missed - a tag named `v0.6.0` can carry a tarball whose `package.json` still
 * says 0.5.0, and a README can point at an asset that was never uploaded. Both failures are silent
 * until someone installs and reads the version back.
 *
 *   node tools/check-release-consistency.mjs            # version vs every documented install URL
 *   node tools/check-release-consistency.mjs v0.6.0     # also: the tag names this version
 *
 * The tag is read from the first argument, else from `GITHUB_REF_NAME` when it looks like a version
 * tag, so a tag-triggered workflow checks it without extra wiring.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packagesDir = join(root, 'packages')
const versionPattern = /^\d+\.\d+\.\d+$/u
const installUrlPattern = /releases\/download\/v(\d+\.\d+\.\d+)\//gu

/** Read every workspace package that publishes a bundle. */
function bundlePackages() {
  const found = []
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const manifestPath = join(packagesDir, entry.name, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (manifest.dsh === undefined || manifest.dsh === null) continue
    found.push({ dir: entry.name, name: manifest.name, version: manifest.version })
  }
  return found
}

const problems = []
const packages = bundlePackages()
if (packages.length === 0) problems.push('no package under packages/* declares a dsh bundle')

for (const manifest of packages) {
  if (typeof manifest.version !== 'string' || !versionPattern.test(manifest.version)) {
    problems.push(`${manifest.name}: version ${String(manifest.version)} is not x.y.z`)
  }
}

const versions = [...new Set(packages.map((manifest) => manifest.version))]
if (versions.length > 1) {
  // One tag names one version, so a release cannot carry two different ones.
  problems.push(`bundle packages disagree on the version: ${versions.join(', ')}`)
}

/** Documented install URLs, with the file they were found in. */
function documentedUrls() {
  const readmes = [
    join(root, 'README.md'),
    join(root, 'README.zh-CN.md'),
    ...packages.map((manifest) => join(packagesDir, manifest.dir, 'README.md')),
  ]
  const found = []
  for (const readme of readmes) {
    if (!existsSync(readme)) continue
    const text = readFileSync(readme, 'utf8')
    for (const match of text.matchAll(installUrlPattern)) {
      found.push({ file: readme.slice(root.length + 1), version: match[1] })
    }
  }
  return found
}

const urls = documentedUrls()
if (urls.length === 0) problems.push('no documented install URL names a release tag')
// A dropped URL is as misleading as a stale one: the English entry point and the package README are
// where someone looks for the install command, so each must carry one.
const requiredFiles = ['README.md', ...packages.map((manifest) => `packages/${manifest.dir}/README.md`)]
for (const required of requiredFiles) {
  if (!urls.some((url) => url.file === required)) {
    problems.push(`${required}: no install URL naming a release tag`)
  }
}
for (const url of urls) {
  if (!versions.includes(url.version)) {
    problems.push(`${url.file}: install URL names v${url.version}, but the bundle is ${versions.join('/')}`)
  }
}

const tag = (process.argv[2] ?? process.env['GITHUB_REF_NAME'] ?? '').trim()
if (tag !== '' && /^v\d+\.\d+\.\d+$/u.test(tag)) {
  if (!versions.includes(tag.slice(1))) {
    problems.push(`tag ${tag} does not name the packaged version ${versions.join('/')}`)
  }
}

if (problems.length > 0) {
  console.error('check-release-consistency: the release would be inconsistent:')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

const names = packages.map((manifest) => `${manifest.name}@${manifest.version}`).join(', ')
const tags = tag === '' ? 'no tag checked' : tag
const files = [...new Set(urls.map((url) => url.file))].join(', ')
console.log(`check-release-consistency: ${names}; ${String(urls.length)} install URL(s) in ${files} agree; ${tags}`)
