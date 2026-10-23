/**
 * Client lifecycle for the SpeechRail Remote contribution, dictionaries and UI slots.
 * @module @hrygo/dsh-speechrail-bundle/client/mount
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@hrygo/dsh-speechrail-bundle/remote'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import {
  PACKAGE_NAME,
  type SpeechRailAcknowledgeRequest,
  type SpeechRailCheckResult,
  type SpeechRailConfigureRequest,
  type SpeechRailConfigureResult,
  type SpeechRailInputStatus,
  type SpeechRailTranscribeRequest,
  type SpeechRailTranscriptionResult,
} from '../contracts.ts'
import { SpeechRailSettings } from './Settings.tsx'
import { VoiceInput, type SpeechRailInjected } from './VoiceInput.tsx'
import { NS, en, zh } from './locales.ts'
import { Recording } from './recording.ts'

/** Services this client face cannot mount without. */
export const inject = ['remote', 'slots', 'locale']

/** Unwrap one Remote result, throwing the transport error the UI localizes generically. */
async function unwrap<T>(pending: Promise<RemoteResult<T>>): Promise<T> {
  const result = await pending
  if (!result.ok) throw result.error
  return result.value
}

/**
 * Register dictionaries and both UI slots, and own every browser recording.
 * @param ctx - Client context carrying the mounted namespace.
 */
function registerUi(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }))
  const recordings = new Set<Recording>()
  ctx.effect(() => async () => {
    await Promise.all([...recordings].map(async (recording) => { await recording.dispose().catch(() => undefined) }))
  })
  const actions: SpeechRailInjected = {
    status: async (): Promise<SpeechRailInputStatus> => await unwrap(ctx.remote.speechrailInput.status()),
    check: async (): Promise<SpeechRailCheckResult> => await unwrap(ctx.remote.speechrailInput.check()),
    configure: async (request: SpeechRailConfigureRequest): Promise<SpeechRailConfigureResult> =>
      await unwrap(ctx.remote.speechrailInput.configure(JSON.stringify(request))),
    acknowledge: async (request: SpeechRailAcknowledgeRequest) =>
      await unwrap(ctx.remote.speechrailInput.acknowledgeUnknown(JSON.stringify(request))),
    transcribe: async (request: SpeechRailTranscribeRequest, signal: AbortSignal): Promise<SpeechRailTranscriptionResult> =>
      await unwrap(ctx.remote.speechrailInput.transcribe(JSON.stringify(request), signal)),
    createRecording: () => {
      const recording = new Recording(() => { recordings.delete(recording) })
      recordings.add(recording)
      return recording
    },
  }
  ctx.slots.inject('conversation.input.activity', () => ctx.slots.register({
    name: 'conversation.input.activity', locale: NS, inject: () => actions,
  }, VoiceInput))
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config', key: PACKAGE_NAME, locale: NS, inject: () => actions,
  }, SpeechRailSettings))
}

/**
 * Mount the generated Remote namespace together with the browser UI.
 * @param ctx - Client runtime owning the Remote, dictionaries and slots.
 * @param contribution - generated SpeechRail Remote definitions.
 * @returns disposer joining UI and Remote withdrawal.
 */
export async function mountSpeechRailInput(ctx: Context, contribution: TypertRemoteContribution): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(contribution)
  const ui = ctx.inject(['remote.speechrailInput', 'slots', 'locale'], registerUi)
  try {
    await ui
  } catch (error) {
    await ui.dispose()
    await disposeRemote()
    throw error
  }
  return async () => { await ui.dispose(); await disposeRemote() }
}
