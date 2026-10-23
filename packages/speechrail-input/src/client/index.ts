/**
 * Browser entry for the SpeechRail Remote contribution and composer control.
 * @module @hrygo/dsh-speechrail-bundle/client
 */

import type { Context } from '@deepseek-ai/cordis'
import speechRailRemote from '@hrygo/dsh-speechrail-bundle/remote'
import { mountSpeechRailInput } from './mount.ts'

export { inject } from './mount.ts'

/**
 * Activate the SpeechRail microphone contribution.
 * @param ctx - Client runtime.
 * @returns complete UI and Remote disposer.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  return await mountSpeechRailInput(ctx, speechRailRemote)
}
