/**
 * Runtime half of the protocol parity check.
 *
 * The workspace-only shim (packages/typert-protocol) tells the Typert generator
 * where `@Remote` and `TypertRemoteService` are declared. That is only honest if
 * the published package really exports those symbols with the contract types this
 * bundle projects; the compile-time half lives in `typert-protocol-parity.host.types.ts`.
 */

import { describe, expect, it } from 'vitest'
import * as Published from '../node_modules/@deepseek-ai/dsh-typert-protocol/lib/types/index.js'

describe('published Typert protocol', () => {
  it('exports the symbols the shim impersonates', () => {
    expect(typeof Published.Remote).toBe('function')
    expect(typeof Published.TypertRemoteService).toBe('function')
    expect(typeof Published.TypertRemoteService.prototype).toBe('object')
  })

  it('exposes the base class the shim impersonates', () => {
    // The compile-time half (typert-protocol-parity.host.types.ts) proves the shapes
    // are assignable in both directions; this only proves the symbols exist at runtime.
    expect(Published.TypertRemoteService.length).toBeGreaterThanOrEqual(0)
    expect(Object.getOwnPropertyNames(Published.TypertRemoteService)).toContain('prototype')
  })
})
