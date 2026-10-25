/**
 * One rendering of a closed failure code, shared by both faces of this plugin.
 *
 * The settings page and the recording control showed the same failure with two copies of the same
 * three lines; the copy for `bad-request` now has to depend on where the refusal came from, which is
 * the sort of rule that must exist once.
 * @module @hrygo/dsh-speechrail-bundle/client/failure-text
 */

import type { SpeechRailFailure } from '../contracts.ts'
import type { SpeechRailKey } from './locales.ts'

/** The subset of a locale function this renderer needs. */
export type FailureTranslate = (key: SpeechRailKey) => string

/**
 * Render one failure for a user.
 *
 * `bad-request` is produced by two unrelated things: a service answering 400 or 422, and this plugin
 * refusing a payload it built itself. Only the first is the service's judgement, and only the first
 * carries a status. Reporting the second as a service refusal would blame a healthy endpoint for an
 * internal defect - and the check row now attaches a "name the model" hint to a refused upload, which
 * would be a contradiction beside it.
 * @param t - localized copy source.
 * @param failure - the closed failure to render.
 * @returns the message, with the service's request id when it issued one.
 */
export function failureText(t: FailureTranslate, failure: SpeechRailFailure): string {
  const code = failure.code === 'bad-request' && failure.httpStatus === null ? 'internal' : failure.code
  const text = t(`failure.${code}` as SpeechRailKey)
  return failure.requestId === null ? text : `${text} (${failure.requestId})`
}
