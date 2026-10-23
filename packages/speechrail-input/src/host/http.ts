/**
 * Bounded, direct HTTP access to the local SpeechRail service.
 *
 * Every request is issued through `node:http` with an explicit loopback host and
 * port. Redirects are never followed, responses are byte-capped, and one deadline
 * covers the whole exchange. Limits of this approach: Node's opt-in environment
 * proxy support (`NODE_USE_ENV_PROXY` / `--use-env-proxy`, Node >= 24.5) would apply
 * to this call, so the no-proxy guarantee holds for a host started without it.
 * @module @hrygo/dsh-speechrail-bundle/host/http
 */

import { randomUUID } from 'node:crypto'
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http'
import {
  CAPABILITY_TIMEOUT_MS,
  TRANSCRIPTION_RESPONSE_MAX_BYTES,
  type SpeechRailCapabilitiesView,
  type SpeechRailFailure,
  type SpeechRailFailureCode,
} from '../contracts.ts'
import type { SpeechRailLimits } from '../types.ts'
import { projectCapabilities } from './capabilities.ts'
import { failure, failureForStatus, readErrorEnvelope, unknownFailure } from './failure.ts'

/** One low-level response. */
export interface HttpSuccess {
  /** Whether a response arrived. */
  readonly ok: true
  /** Response status code. */
  readonly status: number
  /** Response body, already byte-capped. */
  readonly body: Buffer
}

/** One low-level failure. */
export interface HttpFailure {
  /** Whether a response arrived. */
  readonly ok: false
  /** Sanitized failure. */
  readonly failure: SpeechRailFailure
  /** Whether any request byte was written, which is what makes the outcome unprovable. */
  readonly sent: boolean
}

/** Result of one low-level exchange. */
export type HttpResult = HttpSuccess | HttpFailure

/** Options of one low-level exchange. */
export interface HttpRequestOptions {
  /** Absolute URL, already validated as loopback. */
  readonly url: string
  /** HTTP method. */
  readonly method: 'GET' | 'POST'
  /** Request headers. */
  readonly headers: Readonly<Record<string, string>>
  /** Request body, for POST. */
  readonly body?: Buffer | undefined
  /** One deadline covering connect, upload, processing and download. */
  readonly timeoutMs: number
  /** Response byte cap. */
  readonly maxResponseBytes: number
  /** Caller cancellation. */
  readonly signal?: AbortSignal | undefined
}

/**
 * Issue one exchange with an explicit direct socket.
 * @param options - request description.
 * @returns the capped response, or a sanitized failure plus whether bytes were written.
 */
export function performRequest(options: HttpRequestOptions): Promise<HttpResult> {
  return new Promise<HttpResult>((resolve) => {
    let settled = false
    let wrote = false
    let timedOut = false
    let aborted = false
    let deadline: ReturnType<typeof setTimeout> | undefined
    let detachAbort = (): void => {}

    const finish = (result: HttpResult): void => {
      if (settled) return
      settled = true
      if (deadline !== undefined) clearTimeout(deadline)
      detachAbort()
      resolve(result)
    }

    /** Classify a transport failure: bytes already written make the remote outcome unprovable. */
    const transportFailure = (code: SpeechRailFailureCode): void => {
      finish({ ok: false, failure: wrote ? unknownFailure(code) : failure(code), sent: wrote })
    }

    let request: ClientRequest
    try {
      const target = new URL(options.url)
      request = httpRequest({
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: options.method,
        headers: options.headers,
      })
    } catch {
      finish({ ok: false, failure: failure('endpoint-invalid'), sent: false })
      return
    }

    const onAbort = (): void => {
      aborted = true
      request.destroy(new Error('aborted'))
    }
    if (options.signal !== undefined) {
      if (options.signal.aborted) {
        finish({ ok: false, failure: failure('cancelled'), sent: false })
        return
      }
      options.signal.addEventListener('abort', onAbort, { once: true })
      detachAbort = () => { options.signal?.removeEventListener('abort', onAbort) }
    }

    deadline = setTimeout(() => {
      timedOut = true
      request.destroy(new Error('deadline'))
    }, options.timeoutMs)

    request.on('error', () => { transportFailure(aborted ? 'cancelled' : timedOut ? 'timeout' : 'unreachable') })

    request.on('response', (response: IncomingMessage) => {
      const chunks: Buffer[] = []
      let bytes = 0
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.byteLength
        if (bytes > options.maxResponseBytes) {
          response.destroy()
          finish({ ok: false, failure: unknownFailure('malformed-response', { httpStatus: response.statusCode ?? null }), sent: true })
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => {
        finish({ ok: true, status: response.statusCode ?? 0, body: Buffer.concat(chunks) })
      })
      response.on('error', () => { transportFailure('unreachable') })
    })

    request.on('finish', () => { wrote = true })
    if (options.body !== undefined) request.end(options.body)
    else request.end()
  })
}

/** Parse a JSON body without trusting its size or shape. */
function parseJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString('utf8')) as unknown
  } catch {
    return undefined
  }
}

/** Read the non-sensitive part of a failed response body. */
function failureForResponse(status: number, body: Buffer): SpeechRailFailure {
  const envelope = readErrorEnvelope(parseJson(body))
  return failureForStatus(status, envelope.declaredCode, envelope.requestId, envelope.declaredRetryable)
}

/**
 * Strip the characters that could break out of one MIME part or header.
 *
 * RFC 7578 forbids CR/LF in a field value and quote or CR/LF in a name; a value
 * carrying them could otherwise inject an extra part. This is a transport sanitiser
 * rather than validation: a mangled value is still forwarded, so the service can
 * reject it on its own terms.
 * @param text - untrusted name or value.
 * @returns the same text without `"`, CR or LF.
 */
function sanitizeMimePart(text: string): string {
  return text.replace(/["\r\n]/gu, '')
}

/** Encode one multipart/form-data body with a random boundary. */
export function encodeMultipart(
  fields: Readonly<Record<string, string>>,
  file: { readonly name: string; readonly filename: string; readonly contentType: string; readonly data: Uint8Array },
  boundary: string,
): Buffer {
  const head: Buffer[] = []
  for (const [name, value] of Object.entries(fields)) {
    head.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${sanitizeMimePart(name)}"\r\n\r\n${sanitizeMimePart(value)}\r\n`,
      'utf8',
    ))
  }
  head.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${sanitizeMimePart(file.name)}"; filename="${sanitizeMimePart(file.filename)}"\r\n`
    + `Content-Type: ${sanitizeMimePart(file.contentType)}\r\n\r\n`,
    'utf8',
  ))
  return Buffer.concat([
    ...head,
    Buffer.from(file.data),
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
  ])
}

/** Options for one transcription upload. */
export interface TranscribeOptions {
  /** Normalized loopback base URL. */
  readonly baseUrl: string
  /** Optional explicit model id; an empty string omits the field. */
  readonly model: string
  /** Language hint, or null to let the service decide. */
  readonly language: string | null
  /** Resolved bearer credential. */
  readonly credential: string
  /** Canonical WAV bytes. */
  readonly audio: Uint8Array
  /** One request budget. */
  readonly timeoutMs: number
  /** Caller cancellation. */
  readonly signal?: AbortSignal | undefined
}

/** Accepted transcription. */
export interface TranscribeAccepted {
  /** Whether a usable transcript arrived. */
  readonly ok: true
  /** Recognized text. */
  readonly text: string
  /** Wall-clock duration of the whole exchange. */
  readonly requestSeconds: number
}

/** Refused transcription. */
export interface TranscribeRefused {
  /** Whether a usable transcript arrived. */
  readonly ok: false
  /** Sanitized failure. */
  readonly failure: SpeechRailFailure
}

/** Result of one transcription upload. */
export type TranscribeOutcome = TranscribeAccepted | TranscribeRefused

/**
 * Upload one canonical recording and read the JSON transcript.
 * @param options - upload description.
 * @returns the text and wall-clock duration, or a sanitized failure.
 */
export async function transcribe(options: TranscribeOptions): Promise<TranscribeOutcome> {
  const boundary = `----speechrail-input-${randomUUID()}`
  const fields: Record<string, string> = { response_format: 'json' }
  if (options.model !== '') fields.model = options.model
  if (options.language !== null) fields.language = options.language
  const body = encodeMultipart(fields, {
    name: 'file',
    filename: 'recording.wav',
    contentType: 'audio/wav',
    data: options.audio,
  }, boundary)
  const started = performance.now()
  const result = await performRequest({
    url: `${options.baseUrl}/audio/transcriptions`,
    method: 'POST',
    headers: {
      authorization: `Bearer ${options.credential}`,
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': String(body.byteLength),
      accept: 'application/json',
    },
    body,
    timeoutMs: options.timeoutMs,
    maxResponseBytes: TRANSCRIPTION_RESPONSE_MAX_BYTES,
    signal: options.signal,
  })
  const requestSeconds = Math.max(0, (performance.now() - started) / 1000)
  if (!result.ok) return { ok: false, failure: result.failure }
  if (result.status !== 200) return { ok: false, failure: failureForResponse(result.status, result.body) }
  const payload = parseJson(result.body)
  if (typeof payload !== 'object' || payload === null) {
    return { ok: false, failure: failure('malformed-response', { httpStatus: 200 }) }
  }
  const record = payload as Record<string, unknown>
  const usage = record.usage
  const usageValid = typeof usage === 'object' && usage !== null
    && (usage as Record<string, unknown>).type === 'duration'
    && typeof (usage as Record<string, unknown>).seconds === 'number'
    && Number.isFinite((usage as Record<string, unknown>).seconds as number)
    && ((usage as Record<string, unknown>).seconds as number) >= 0
  if (typeof record.text !== 'string' || !usageValid) {
    return { ok: false, failure: failure('malformed-response', { httpStatus: 200 }) }
  }
  return { ok: true, text: record.text, requestSeconds }
}

/** Options for one capability probe. */
export interface ProbeOptions {
  /** Normalized loopback base URL. */
  readonly baseUrl: string
  /** Resolved bearer credential. */
  readonly credential: string
  /** Probe budget; defaults to the capability timeout. */
  readonly timeoutMs?: number | undefined
  /** Caller cancellation. */
  readonly signal?: AbortSignal | undefined
  /** Limits in force before this probe; a limit the snapshot omits keeps its value. */
  readonly previousLimits?: SpeechRailLimits | null | undefined
}

/** Successful probe. */
export interface ProbeAccepted {
  /** Whether the probe produced a usable snapshot. */
  readonly ok: true
  /** Projected capability facts, or null when the body was not a snapshot. */
  readonly capabilities: SpeechRailCapabilitiesView | null
}

/** Failed probe that still reached the service. */
export interface ProbeRefused {
  /** Whether the probe produced a usable snapshot. */
  readonly ok: false
  /** Whether any HTTP response arrived. */
  readonly reachable: boolean
  /** Whether that response was authorized. */
  readonly authenticated: boolean
  /** Sanitized failure, or null when the response simply was not a snapshot. */
  readonly failure: SpeechRailFailure | null
}

/** Result of one capability probe. */
export type ProbeOutcome = ProbeAccepted | ProbeRefused

/**
 * Read the effective capability snapshot.
 * @param options - probe description.
 * @returns projected facts, or a classified refusal that never carries the body.
 */
export async function probeCapabilities(options: ProbeOptions): Promise<ProbeOutcome> {
  const result = await performRequest({
    url: `${options.baseUrl}/speechrail/capabilities`,
    method: 'GET',
    headers: { authorization: `Bearer ${options.credential}`, accept: 'application/json' },
    timeoutMs: options.timeoutMs ?? CAPABILITY_TIMEOUT_MS,
    maxResponseBytes: TRANSCRIPTION_RESPONSE_MAX_BYTES,
    signal: options.signal,
  })
  if (!result.ok) return { ok: false, reachable: false, authenticated: false, failure: result.failure }
  if (result.status !== 200) {
    return {
      ok: false,
      reachable: true,
      authenticated: result.status !== 401 && result.status !== 403,
      failure: failureForResponse(result.status, result.body),
    }
  }
  return { ok: true, capabilities: projectCapabilities(parseJson(result.body), options.previousLimits ?? null) }
}
