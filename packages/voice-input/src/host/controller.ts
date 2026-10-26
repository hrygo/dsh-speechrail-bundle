/**
 * Authenticated Remote surface of the SpeechRail voice input service.
 *
 * Payloads arrive as bounded JSON text on purpose: the generated Host dispatch codec
 * strips unknown fields from declared objects, so only a string carrier can guarantee
 * that an unexpected field is refused rather than silently dropped.
 * @module dsh-voice-input/host/controller
 */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  type SpeechRailAcknowledgeResult,
  type SpeechRailCheckResult,
  type SpeechRailConfigureResult,
  type SpeechRailInputStatus,
  type SpeechRailTranscriptionResult,
} from '../contracts.ts'
import type {} from './service.ts'

/**
 * The generator only accepts a literal namespace argument in `super()`. This guard
 * fails the build if the literal drifts from the exported client-facing constant.
 */
export type ControllerNamespaceGuard = 'speechrailInput' extends typeof import('../contracts.ts').REMOTE_NAMESPACE ? true : never

/** Remote controller exposing this bundle to browser clients. */
export default class SpeechRailInputController extends TypertRemoteService {
  constructor(ctx: Context) {
    // The generator requires literal arguments here; {@link REMOTE_NAMESPACE} holds the
    // same literal for the client face, so the two cannot drift without a type error.
    super(ctx, 'speechrailInputController', { namespace: 'speechrailInput' })
  }

  /**
   * Read the current status without starting work.
   * @returns status, limits, cached capability facts and the gate state.
   */
  @Remote
  status(): Promise<SpeechRailInputStatus> {
    return this.ctx.speechrailInput.status()
  }

  /**
   * Probe the configured service and refresh cached capabilities.
   * @returns probe facts; a successful probe never clears an unproven outcome.
   */
  @Remote
  check(): Promise<SpeechRailCheckResult> {
    return this.ctx.speechrailInput.check()
  }

  /**
   * Persist language and request budget through Settings.
   * @param payload - bounded JSON carrier text.
   * @returns the new revision, or a localized-code failure.
   */
  @Remote
  configure(payload: string): Promise<SpeechRailConfigureResult> {
    return this.ctx.speechrailInput.configure(payload)
  }

  /**
   * Upload one recording and return its transcript.
   * @param payload - bounded JSON carrier text holding the operation id and base64 audio.
   * @param signal - client cancellation or Remote disposal.
   * @returns the transcript, or a sanitized failure.
   */
  @Remote
  transcribe(payload: string, signal: AbortSignal): Promise<SpeechRailTranscriptionResult> {
    return this.ctx.speechrailInput.transcribe(payload, signal)
  }

  /**
   * Acknowledge an unproven remote outcome and open the gate again.
   * @param payload - bounded JSON carrier text holding the operation id.
   * @returns the remaining pending operation, or a refusal.
   */
  @Remote
  acknowledgeUnknown(payload: string): Promise<SpeechRailAcknowledgeResult> {
    return this.ctx.speechrailInput.acknowledgeUnknown(payload)
  }
}
