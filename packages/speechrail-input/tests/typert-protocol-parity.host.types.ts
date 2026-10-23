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
