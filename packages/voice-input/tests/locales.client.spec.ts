/** Both client dictionaries must stay complete, in step, and cover every failure code. */

import { describe, expect, it } from 'vitest'
import { SPEECHRAIL_FAILURE_CODES } from '../src/contracts.ts'
import { NS, en, zh } from '../src/client/locales.ts'

describe('client dictionaries', () => {
  it('declares one namespace', () => {
    expect(NS).toBe('voice-input')
  })

  it('carries the same keys in both languages', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('has copy for every closed failure code', () => {
    const missing = SPEECHRAIL_FAILURE_CODES.filter((code) => {
      const key = `failure.${code}`
      return !(key in zh) || !(key in en)
    })
    expect(missing).toEqual([])
  })

  it('has copy for every capture refusal', () => {
    for (const kind of ['permission', 'unavailable', 'deviceMissing', 'cancelled', 'interrupted', 'empty', 'tooLarge']) {
      expect(zh).toHaveProperty(`capture.${kind}`)
      expect(en).toHaveProperty(`capture.${kind}`)
    }
  })

  it('uses no static key the dictionaries do not define', async () => {
    // A typo in a t('...') call renders the key itself to the user, and the checks above cannot see it:
    // they only compare the two dictionaries with each other. Template forms (`t(`failure.${code}`)`)
    // are deliberately not parsed here - the failure-code and capture-refusal cases above cover them.
    // Not `import.meta.url`: under the client's jsdom environment it is not a file URL. The suite runs
    // either from the repository root or from the package directory, so both are tried.
    const { existsSync, readdirSync, readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const directory = [
      join(process.cwd(), 'packages/voice-input/src/client'),
      join(process.cwd(), 'src/client'),
    ].find((candidate) => existsSync(candidate))
    if (directory === undefined) throw new Error('cannot locate src/client to scan')
    const missing: string[] = []
    let checked = 0
    for (const file of readdirSync(directory).filter((name) => /\.tsx?$/u.test(name))) {
      const text = readFileSync(join(directory, file), 'utf8')
      for (const match of text.matchAll(/\bt\('([A-Za-z][\w.]*)'|\bt\("([A-Za-z][\w.]*)"|\bt\(`([A-Za-z][\w.]*)\./gu)) {
        const key = match[1] ?? match[2]
        if (key === undefined) continue
        checked += 1
        if (!(key in zh)) missing.push(`${file}: ${key}`)
      }
    }
    expect(checked).toBeGreaterThan(30)
    expect(missing).toEqual([])
  })

  it('never ships empty strings', () => {
    for (const [key, value] of [...Object.entries(zh), ...Object.entries(en)]) {
      expect(value.trim(), key).not.toBe('')
    }
  })
})
