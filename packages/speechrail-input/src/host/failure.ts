/**
 * Sanitized failure construction: the only shape an error may take on the wire.
 * @module @hrygo/dsh-speechrail-bundle/host/failure
 */

import type { SpeechRailFailure, SpeechRailFailureCode, SpeechRailOutcome } from '../contracts.ts'

/** Codes whose repetition could plausibly succeed without changing user intent. */
const RETRYABLE: ReadonlySet<SpeechRailFailureCode> = new Set([
  'unreachable',
  'timeout',
  'busy',
  'rate-limited',
  'server-error',
])

/**
 * Declared error codes that name a condition better than the status can.
 *
 * Measured against the live service: a non-audio upload answered `422` with
 * `{"error":{"code":"audio_decode_failed", ...}}`, which the status alone would report as a
 * configuration problem. Only codes observed or documented for this endpoint belong here; an
 * unrecognised declared code changes nothing.
 */
const DECLARED_CODES: Readonly<Record<string, SpeechRailFailureCode>> = {
  audio_decode_failed: 'audio-invalid',
}

/**
 * Status a declared code was observed on, and the only one it may override.
 *
 * The code names the condition, but the status still decides settlement, authentication and routing:
 * a 401 that happens to carry an audio code is a refusal of the credential, not a bad recording.
 */
const DECLARED_CODE_STATUS = 422

/**
 * Build one sanitized failure.
 * @param code - closed failure code.
 * @param options - HTTP status, server request id and outcome override.
 * @returns a failure carrying no response body, path, secret or transcript text.
 */
export function failure(
  code: SpeechRailFailureCode,
  options: { readonly httpStatus?: number | null; readonly requestId?: string | null; readonly outcome?: SpeechRailOutcome } = {},
): SpeechRailFailure {
  const httpStatus = options.httpStatus ?? null
  return {
    code,
    httpStatus,
    retryable: RETRYABLE.has(code),
    requestId: sanitizeRequestId(options.requestId ?? null),
    outcome: options.outcome ?? 'failed',
  }
}

/**
 * Build a failure whose remote outcome could not be proven, so the gate must stay closed
 * until the user acknowledges it.
 * @param code - closed failure code.
 * @param options - HTTP status and server request id.
 * @returns a failure with `outcome: 'unknown'`.
 */
export function unknownFailure(
  code: SpeechRailFailureCode,
  options: { readonly httpStatus?: number | null; readonly requestId?: string | null } = {},
): SpeechRailFailure {
  return failure(code, { ...options, outcome: 'unknown' })
}

/**
 * Keep a server request id only when it looks like one: bounded, printable, no separators.
 * @param value - candidate id from an untrusted body or header.
 * @returns the id, or null when it is absent or implausible.
 */
export function sanitizeRequestId(value: string | null): string | null {
  if (value === null) return null
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > 64) return null
  return /^[A-Za-z0-9_-]+$/u.test(trimmed) ? trimmed : null
}

/**
 * Reduce an untrusted reason string to a short diagnostic token.
 * @param value - candidate reason from a capability snapshot.
 * @returns the token, or null when it is absent or implausible.
 */
export function sanitizeReason(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().toLowerCase()
  if (trimmed === '' || trimmed.length > 64) return null
  return /^[a-z0-9_]+$/u.test(trimmed) ? trimmed : null
}

/** Shape of the SpeechRail JSON error envelope, read defensively and never forwarded. */
interface ErrorEnvelope {
  readonly error?: { readonly code?: unknown; readonly request_id?: unknown; readonly retryable?: unknown }
}
/**
 * Extract only the non-sensitive fields of a SpeechRail error body.
 * @param body - decoded JSON value of a failed response.
 * @returns the server request id, its error code, and declared retryability.
 */
export function readErrorEnvelope(body: unknown): { readonly requestId: string | null; readonly declaredCode: string | null; readonly declaredRetryable: boolean | null } {
  if (typeof body !== 'object' || body === null) return { requestId: null, declaredCode: null, declaredRetryable: null }
  const error = (body as ErrorEnvelope).error
  if (typeof error !== 'object' || error === null) return { requestId: null, declaredCode: null, declaredRetryable: null }
  const requestId = typeof error.request_id === 'string' ? sanitizeRequestId(error.request_id) : null
  const declaredCode = typeof error.code === 'string' && /^[a-z0-9_]{1,64}$/u.test(error.code) ? error.code : null
  const declaredRetryable = typeof error.retryable === 'boolean' ? error.retryable : null
  return { requestId, declaredCode, declaredRetryable }
}

/**
 * Whether an answered status proves the service did not process the upload.
 *
 * Only the service refusing the request itself proves that: 4xx, except 408 Request Timeout. A 5xx
 * may be a gateway timing out while an upstream worker is still transcribing (504 says exactly
 * that), a 3xx tells the client to look elsewhere without establishing anything about the bytes, and
 * a 2xx that is not 200 - 202 Accepted above all - can mean the work is explicitly still running.
 * Those outcomes stay unproven, so the pending journal is kept and the gate keeps asking.
 *
 * This is the only rule that decides it; the upload path must not grow a second one.
 *
 * @param status - response status code that reached the client.
 * @returns whether the upload provably was not processed.
 */
export function provesNotProcessed(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408
}

/**
 * Map an HTTP status to the closed failure vocabulary.
 * @param status - response status code.
 * @param declaredCode - server error code, inspected only for model-specific refusals.
 * @param requestId - sanitized server request id.
 * @param declaredRetryable - server-declared retryability.
 * @returns the sanitized failure.
 */
export function failureForStatus(
  status: number,
  declaredCode: string | null,
  requestId: string | null,
  declaredRetryable: boolean | null,
): SpeechRailFailure {
  // `Object.hasOwn`, not a bare lookup: the declared-code filter admits the inherited names
  // `constructor` and `__proto__`, and a bare lookup would return a function or a prototype where a
  // failure code belongs - which then fails the Remote codec's own validation instead of reporting a
  // refusal.
  const declared = status !== DECLARED_CODE_STATUS || declaredCode === null
    || !Object.hasOwn(DECLARED_CODES, declaredCode)
    ? undefined
    : DECLARED_CODES[declaredCode]
  const code: SpeechRailFailureCode = declared ?? (status === 401 || status === 403
    ? 'unauthorized'
    : status === 404
      ? 'not-found'
      : status === 408 || status === 504
        ? 'timeout'
        : status === 413
          // Payload too large: the take, not its format.
          ? 'audio-too-large'
          : status === 415
            ? 'audio-invalid'
          : status === 400 && declaredCode === 'model_not_found'
            ? 'model-not-found'
            : status >= 500
              ? 'server-error'
              : status === 429
                // The endpoint declares 429; the service is throttling, which is worth retrying
                // rather than reading as a configuration problem.
                ? 'rate-limited'
                : status >= 400
                  ? 'bad-request'
                  : status >= 300
                    // This bundle never follows a redirect, so a 3xx is a deliberate refusal
                    // by the server and not an internal fault.
                    ? 'redirected'
                    : 'internal')
  const base = failure(code, { httpStatus: status, requestId })
  return declaredRetryable === null ? base : { ...base, retryable: declaredRetryable && base.retryable }
}
