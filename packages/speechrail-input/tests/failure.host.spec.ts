import { describe, expect, it } from 'vitest'
import { failure, failureForStatus, provesNotProcessed, readErrorEnvelope, sanitizeReason, sanitizeRequestId, unknownFailure } from '../src/host/failure.ts'

describe('provesNotProcessed', () => {
  it('proves non-processing only for a refusal, and for nothing else', () => {
    // The single rule the whole gate settlement rests on. Every other status - a 5xx a gateway may
    // answer while an upstream worker keeps transcribing, a 3xx, a 408 Request Timeout, a 2xx that is
    // not a finished 200 - leaves the outcome unproven.
    const refused = [400, 401, 403, 404, 405, 409, 413, 415, 422, 429, 451]
    const unproven = [100, 101, 200, 201, 202, 204, 301, 302, 304, 408, 500, 501, 502, 503, 504, 599]
    for (const status of refused) expect(provesNotProcessed(status), `refused ${status}`).toBe(true)
    for (const status of unproven) expect(provesNotProcessed(status), `unproven ${status}`).toBe(false)
  })
})

describe('failure', () => {
  it('marks connectivity failures retryable and content failures not retryable', () => {
    expect(failure('unreachable').retryable).toBe(true)
    expect(failure('busy').retryable).toBe(true)
    expect(failure('unauthorized').retryable).toBe(false)
    expect(failure('audio-invalid').retryable).toBe(false)
    // A take over a ceiling is not retryable as-is: repeating it changes nothing, shortening it does.
    expect(failure('audio-too-long').retryable).toBe(false)
    expect(failure('audio-too-large').retryable).toBe(false)
  })

  it('reports an unproven remote outcome separately from a proven failure', () => {
    expect(failure('timeout').outcome).toBe('failed')
    expect(unknownFailure('timeout').outcome).toBe('unknown')
    expect(unknownFailure('cancelled').outcome).toBe('unknown')
  })

  it('carries no free-form message field at all', () => {
    const shaped = failure('server-error', { httpStatus: 500, requestId: 'req_123' })
    expect(Object.keys(shaped).sort()).toEqual(['code', 'httpStatus', 'outcome', 'requestId', 'retryable'])
  })
})

describe('failureForStatus', () => {
  it('maps authentication and routing statuses', () => {
    expect(failureForStatus(401, 'invalid_api_key', null, null).code).toBe('unauthorized')
    expect(failureForStatus(403, null, null, null).code).toBe('unauthorized')
    expect(failureForStatus(404, null, null, null).code).toBe('not-found')
    expect(failureForStatus(500, null, null, null).code).toBe('server-error')
    expect(failureForStatus(503, null, null, null).code).toBe('server-error')
  })

  it('separates an unknown model from a generic bad request', () => {
    expect(failureForStatus(400, 'model_not_found', null, null).code).toBe('model-not-found')
    expect(failureForStatus(400, 'invalid_chunking_strategy', null, null).code).toBe('bad-request')
  })

  it('treats an oversized or unsupported upload as invalid audio', () => {
    expect(failureForStatus(413, null, null, null).code).toBe('audio-invalid')
    expect(failureForStatus(415, null, null, null).code).toBe('audio-invalid')
  })

  it('honours a server that declares its own failure non-retryable', () => {
    expect(failureForStatus(503, null, null, false).retryable).toBe(false)
    expect(failureForStatus(503, null, null, true).retryable).toBe(true)
  })
})

describe('sanitizers', () => {
  it('keeps plausible request ids and drops anything path- or body-like', () => {
    expect(sanitizeRequestId(' req_abc123 ')).toBe('req_abc123')
    expect(sanitizeRequestId('req/../../etc/passwd')).toBeNull()
    expect(sanitizeRequestId('a'.repeat(65))).toBeNull()
    expect(sanitizeRequestId('')).toBeNull()
    expect(sanitizeRequestId(null)).toBeNull()
  })

  it('reduces reasons to short lowercase tokens', () => {
    expect(sanitizeReason('asr_not_ready')).toBe('asr_not_ready')
    expect(sanitizeReason('Model file /opt/model.bin missing')).toBeNull()
    expect(sanitizeReason(7)).toBeNull()
  })
})

describe('readErrorEnvelope', () => {
  it('extracts only the request id, error code and declared retryability', () => {
    expect(readErrorEnvelope({
      error: {
        message: 'Invalid or missing API key',
        type: 'authentication_error',
        code: 'invalid_api_key',
        request_id: 'req_9f2',
        retryable: false,
      },
    })).toEqual({ requestId: 'req_9f2', declaredCode: 'invalid_api_key', declaredRetryable: false })
  })

  it('ignores bodies that do not carry the expected envelope', () => {
    expect(readErrorEnvelope(null)).toEqual({ requestId: null, declaredCode: null, declaredRetryable: null })
    expect(readErrorEnvelope('boom')).toEqual({ requestId: null, declaredCode: null, declaredRetryable: null })
    expect(readErrorEnvelope({ detail: 'boom' })).toEqual({ requestId: null, declaredCode: null, declaredRetryable: null })
    expect(readErrorEnvelope({ error: { request_id: 'a/b', code: 'Invalid Key', retryable: 'yes' } })).toEqual({
      requestId: null,
      declaredCode: null,
      declaredRetryable: null,
    })
  })
})
