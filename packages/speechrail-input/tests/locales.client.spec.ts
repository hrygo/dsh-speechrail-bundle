/** Both client dictionaries must stay complete, in step, and cover every failure code. */

import { describe, expect, it } from 'vitest'
import { SPEECHRAIL_FAILURE_CODES } from '../src/contracts.ts'
import { NS, en, zh } from '../src/client/locales.ts'

describe('client dictionaries', () => {
  it('declares one namespace', () => {
    expect(NS).toBe('speechrail-input')
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
    for (const kind of ['permission', 'unavailable', 'deviceMissing', 'interrupted', 'empty', 'tooLarge']) {
      expect(zh).toHaveProperty(`capture.${kind}`)
      expect(en).toHaveProperty(`capture.${kind}`)
    }
  })

  it('never ships empty strings', () => {
    for (const [key, value] of [...Object.entries(zh), ...Object.entries(en)]) {
      expect(value.trim(), key).not.toBe('')
    }
  })
})
