/**
 * One failure code, two origins - and the message must not confuse them.
 *
 * `bad-request` is returned both by a service answering 400/422 and by this plugin refusing a payload
 * it built itself. Both faces of the plugin render failures through this one function.
 */

import { describe, expect, it } from 'vitest'
import { failureText } from '../src/client/failure-text.ts'
import type { SpeechRailKey } from '../src/client/locales.ts'
import type { SpeechRailFailure } from '../src/types.ts'

/** Keeps interpolation visible, so a test can see which key was chosen. */
const t = (key: SpeechRailKey): string => key

function shaped(overrides: Partial<SpeechRailFailure> = {}): SpeechRailFailure {
  return { code: 'bad-request', httpStatus: 400, retryable: false, requestId: null, outcome: 'failed', ...overrides }
}

describe('failure rendering', () => {
  it('reports a service refusal as the service refusing the upload', () => {
    expect(failureText(t, shaped({ httpStatus: 422 }))).toBe('failure.bad-request')
  })

  it('does not blame the service for a payload this plugin refused itself', () => {
    // A locally refused carrier means an internal defect; the service never saw a request, and the
    // service-facing copy now tells the reader to check a model the service was never asked about.
    expect(failureText(t, shaped({ httpStatus: null }))).toBe('failure.internal')
  })

  it('keeps every other code as it is, status or not', () => {
    expect(failureText(t, shaped({ code: 'unreachable', httpStatus: null }))).toBe('failure.unreachable')
    expect(failureText(t, shaped({ code: 'timeout', httpStatus: 504 }))).toBe('failure.timeout')
  })

  it('appends the request id a service issued, and nothing when it issued none', () => {
    expect(failureText(t, shaped({ requestId: 'req_1234' }))).toBe('failure.bad-request (req_1234)')
    expect(failureText(t, shaped())).toBe('failure.bad-request')
  })
})
