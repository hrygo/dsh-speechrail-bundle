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

  it('keeps the Remote contract shapes this bundle projects', () => {
    const options: Published.TypertGatewayBindingOptions = { namespace: 'speechrailInput' }
    const contribution: Published.TypertRemoteContribution = { package: '@hrygo/dsh-speechrail-bundle', descriptors: [] }
    const ok: Published.RemoteResult<number> = { ok: true, value: 1 }
    // The published error side is a class instance, so the shape is asserted on a
    // declared value instead of a literal: this bundle only ever reads `.message`.
    const failure = undefined as unknown as Published.RemoteFailure
    const failed: Published.RemoteResult<number> = { ok: false, error: failure }
    expect(options.namespace).toBe('speechrailInput')
    expect(contribution.descriptors).toHaveLength(0)
    expect(ok.ok).toBe(true)
    expect(failed.ok).toBe(false)
  })
})
