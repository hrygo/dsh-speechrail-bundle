/**
 * Compile-time half of the protocol parity check.
 *
 * Not executed: it proves that the decorator and constructor pattern used by
 * `src/host/controller.ts` also compiles against the *published*
 * `@deepseek-ai/dsh-typert-protocol` declarations, so the workspace shim cannot
 * drift into accepting a pattern the real protocol rejects.
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  Remote as PublishedRemote,
  TypertRemoteService as PublishedService,
} from '../node_modules/@deepseek-ai/dsh-typert-protocol/lib/types/index.js'

/** Mirrors the controller's shape against the published declarations. */
class PublishedPatternProbe extends PublishedService {
  constructor(ctx: Context) {
    super(ctx, 'publishedPatternProbe', { namespace: 'publishedPatternProbe' })
  }

  @PublishedRemote
  status(): Promise<number> {
    return Promise.resolve(1)
  }

  @PublishedRemote
  transcribe(payload: string, signal: AbortSignal): Promise<number> {
    void payload
    void signal
    return Promise.resolve(2)
  }
}

/** Keeps the probe referenced without running a decorator through the executor. */
export const publishedPatternProbe = PublishedPatternProbe

/**
 * Structural assignability of the shapes this bundle projects.
 *
 * A type-level proof, not a runtime one: everything the *published* declarations
 * produce must be readable through the shim, so shim-typed code cannot be surprised
 * by the real package. The reverse direction is deliberately not required: the shim
 * widens `RemoteResult`'s error side to a plain interface, because this bundle only
 * ever reads `error.message` and never constructs one.
 */
import type * as Shim from '@deepseek-ai/dsh-typert-protocol'
import type * as Published from '../node_modules/@deepseek-ai/dsh-typert-protocol/lib/types/index.js'

declare const publishedResult: Published.RemoteResult<number>
declare const publishedContribution: Published.TypertRemoteContribution
declare const publishedOptions: Published.TypertGatewayBindingOptions

const shimReadsPublished: readonly [
  Shim.RemoteResult<number>,
  Shim.TypertRemoteContribution,
  Shim.TypertGatewayBindingOptions,
] = [publishedResult, publishedContribution, publishedOptions]

/** Keeps the proof referenced without emitting anything. */
export const protocolAssignability = { shimReadsPublished }
