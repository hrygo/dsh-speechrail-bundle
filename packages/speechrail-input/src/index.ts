/**
 * Independent SpeechRail voice input bundle: Host entry.
 *
 * The bundle deliberately owns one service and one Remote surface, and reuses no
 * official voice package at runtime. Browser capture lives in the Client face.
 * @module @hrygo/dsh-speechrail-bundle
 */

import type { Context } from '@deepseek-ai/cordis'
import { BUNDLE_ENTRY_ID } from './contracts.ts'
import type { SpeechRailInputConfig } from './host/config.ts'
import SpeechRailInputController from './host/controller.ts'
import SpeechRailInput from './host/service.ts'

export { Config } from './host/config.ts'
// The service class is part of the public surface: the Typert analyzer attributes a
// `Context` augmentation to the exported symbol it names, so an unexported class
// would advertise no service at all.
export { default as SpeechRailInput } from './host/service.ts'
// The Remote controller is exported for the same reason: reflection reads the
// `@Remote` methods off a symbol the package's public surface names.
export { default as SpeechRailInputController } from './host/controller.ts'
export type * from './contracts.ts'

/** Loader entry id this bundle's patch inserts. */
export const name = BUNDLE_ENTRY_ID

/**
 * Hard requirements of this entry. Settings, storage and the Remote registry stay
 * optional so a composition without them loads and reports why it cannot record.
 */
export const inject = ['credentials', 'typert']

/**
 * Register the transcription service and its authenticated Remote surface.
 *
 * The journal is read before the Remote is mounted, so a client can never observe a
 * gate that has not yet accounted for an earlier unproven upload.
 * @param ctx - Host context owning the entry.
 * @param config - validated entry configuration.
 * @returns after the service is reachable.
 */
export async function apply(ctx: Context, config: SpeechRailInputConfig): Promise<void> {
  const service = new SpeechRailInput(ctx, config)
  await service.restore()
  new SpeechRailInputController(ctx)
}
