/**
 * Bounded, direct HTTP access to the local SpeechRail service.
 *
 * Every request is issued through `node:http` with an explicit loopback host and
 * port. Redirects are never followed, responses are byte-capped, and one deadline
 * covers the whole exchange. `agent: false` is what keeps a host that enabled Node's
 * opt-in environment proxy (`NODE_USE_ENV_PROXY` / `--use-env-proxy`, Node >= 24.5) from
 * routing this request: measured on Node 26.11.1, a request through the default agent
 * reached the proxy while this shape connected to its target directly.
 * @module dsh-voice-input/host/http
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
import type { SpeechRailAuthentication, SpeechRailLimits } from '../types.ts'
import { projectCapabilities } from './capabilities.ts'
import { failure, failureForStatus, provesNotProcessed, readErrorEnvelope, unknownFailure } from './failure.ts'

/** One low-level response. */
export interface HttpSuccess {
  /** Whether a response arrived. */
  readonly ok: true
  /** Response status code. */
  readonly status: number
  /** Response body, already byte-capped. */
  readonly body: Buffer
  /**
   * Whether the response stated its own length, so its body is provably complete.
   *
   * Without this the body ends when the socket does, and a reply cut mid-transcript cannot be told
   * from a complete one. See {@link framingProof} for why only a stated length qualifies.
   */
  readonly framed: boolean
}

/** One low-level failure. */
export interface HttpFailure {
  /** Whether a response arrived. */
  readonly ok: false
  /** Sanitized failure. */
  readonly failure: SpeechRailFailure
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
/**
 * Strip the brackets `new URL` keeps around an IPv6 literal.
 *
 * Node treats `'[::1]'` as a name to resolve rather than as an address, so passing it
 * through would send a loopback-only request to whatever DNS answers — or fail.
 * @param hostname - `URL.hostname`, possibly bracketed.
 * @returns the bare address, suitable for `http.request`.
 */
export function unbracketHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/gu, '')
}

/**
 * Whether this response proves where its body ends.
 *
 * Only a `Content-Length` proves it. A `Transfer-Encoding` statement cannot: Node *reports* header
 * values trimmed while it decides framing on the raw bytes, so a legal `Transfer-Encoding: chunked\t`
 * (HTAB is optional whitespace) is close-delimited here yet reported as exactly `chunked` - the same
 * string a genuinely chunked reply reports, with `rawHeaders` trimmed too. There is therefore no value
 * test that separates the two, and believing a merely *stated* framing is the dangerous direction: an
 * unusable body would settle, clearing the journal and opening the gate for an outcome the service
 * never confirmed. That covers unusable bodies only - a reply cut at a JSON boundary can still parse
 * and settle as a success under either rule, which is why this is consulted only where the body could
 * not be used at all. The price is that a complete chunked reply whose body is unusable stays unproven
 * and needs an acknowledgement; measured, and recorded as a deliberate trade-off.
 * @param response - the response whose body was received.
 * @returns true only when the transport stated the body's length.
 */
function framingProof(response: IncomingMessage): boolean {
  return response.headers['content-length'] !== undefined
}

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

    /**
     * Classify a transport failure: bytes already written make the remote outcome unprovable.
     *
     * `responded` is the status of a response head that did arrive, so a stall or reset mid-body
     * still reports the service as reachable - which is what the probe's `reachable` field promises.
     * It settles the gate only when that status proves the upload was not processed
     * (`provesNotProcessed`); a 5xx head, which may be a gateway giving up on an upstream that is
     * still working, keeps the outcome unproven.
     */
    const transportFailure = (code: SpeechRailFailureCode): void => {
      const status = responded
      const options = { httpStatus: status }
      finish({
        ok: false,
        // An arrived refusal outranks the transport code and the `wrote` bookkeeping: a service that
        // checks the authorization header answers 401 without waiting for a body it may still be
        // receiving, and reporting `unreachable` beside an answered status would be plainly false.
        // Reachable on loopback with a large enough body: a server that flushes a 401 head and drops
        // the socket while several megabytes are still being written reproduces it, which is what
        // `tests/http-transport.host.spec.ts` pins.
        failure: status !== null && provesNotProcessed(status)
          ? failureForStatus(status, null, null, null)
          : !wrote
            ? failure(code, options)
            : unknownFailure(code, options),
      })
    }

    let responded: number | null = null
    let request: ClientRequest
    try {
      const target = new URL(options.url)
      request = httpRequest({
        protocol: target.protocol,
        // `new URL('http://[::1]:1/').hostname` keeps the brackets, and Node would then
        // treat the literal as a name to resolve: the request could leave loopback and
        // fail. Strip them so ::1 stays ::1.
        hostname: unbracketHostname(target.hostname),
        // A loopback-only endpoint has no legitimate proxy, and Node's env-proxy opt-in
        // (NODE_USE_ENV_PROXY / --use-env-proxy) would otherwise send the bearer
        // credential and the audio to HTTP_PROXY.
        agent: false,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: options.method,
        headers: options.headers,
      })
    } catch {
      finish({ ok: false, failure: failure('endpoint-invalid') })
      return
    }

    const onAbort = (): void => {
      aborted = true
      request.destroy(new Error('aborted'))
    }
    if (options.signal !== undefined) {
      if (options.signal.aborted) {
        finish({ ok: false, failure: failure('cancelled') })
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

    // Informational responses arrive on their own event, and one still proves the service
    // answered; without this a 103-then-stall would be reported as unreachable.
    request.on('information', (info: { readonly statusCode?: number | undefined }) => {
      responded ??= info.statusCode ?? null
    })

    // A 101 Upgrade is neither `information` nor `response`, and once it has upgraded the
    // deadline and destroy() settle nothing: without this the promise never resolves and
    // the gate stays busy forever.
    request.on('upgrade', (_response: IncomingMessage, socket: { destroy: () => void }) => {
      responded = 101
      socket.destroy()
      transportFailure('unreachable')
    })

    request.on('response', (response: IncomingMessage) => {
      responded = response.statusCode ?? null
      const chunks: Buffer[] = []
      let bytes = 0
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.byteLength
        if (bytes > options.maxResponseBytes) {
          response.destroy()
          const status = response.statusCode ?? null
          // Same rule as a stalled body: only a status that proves the request was not processed
          // settles the gate, even though the body that followed it was unusable.
          finish({
            ok: false,
            failure: status !== null && provesNotProcessed(status)
              ? failureForStatus(status, null, null, null)
              : unknownFailure('malformed-response', { httpStatus: status }),
          })
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => {
        finish({
          ok: true,
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks),
          // Framing means the reply proves where its body ends; see framingProof for why only a
          // stated length can prove it.
          framed: framingProof(response),
        })
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
  /** Resolved bearer credential, or null when the endpoint needs none. */
  readonly credential: string | null
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
  const boundary = `----voice-input-${randomUUID()}`
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
      // A null credential means this endpoint was configured as needing none: the header is
      // omitted rather than sent empty, which some servers read as a malformed token.
      ...(options.credential === null ? {} : { authorization: `Bearer ${options.credential}` }),
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
  if (result.status !== 200) {
    // 202 Accepted is the canonical "still working", and a complete 5xx or 3xx body does not
    // establish what happened to the bytes either: only a status that proves the request was not
    // processed lets the gate settle. The code still says what arrived.
    if (result.status >= 200 && result.status < 300) {
      return { ok: false, failure: unknownFailure('malformed-response', { httpStatus: result.status }) }
    }
    const answered = failureForResponse(result.status, result.body)
    return {
      ok: false,
      failure: provesNotProcessed(result.status) ? answered : { ...answered, outcome: 'unknown' },
    }
  }
  // A 200 whose body cannot be used is settled only when the service framed its reply: framing
  // proves the reply ended, so nothing is still in flight. Without it the body may have been cut
  // mid-transcript, and the outcome stays unproven - the same reading the stalled-body path takes.
  const unusable = result.framed
    ? failure('malformed-response', { httpStatus: 200 })
    : unknownFailure('malformed-response', { httpStatus: 200 })
  const payload = parseJson(result.body)
  if (typeof payload !== 'object' || payload === null) return { ok: false, failure: unusable }
  const record = payload as Record<string, unknown>
  // `usage` is SpeechRail's own extension and no consumer reads it, so only `text` decides whether
  // the answer is usable. A malformed `usage` is ignored rather than allowed to discard a transcript
  // the service really produced: strictness on an unread optional field is not worth the take.
  if (typeof record.text !== 'string') return { ok: false, failure: unusable }
  return { ok: true, text: record.text, requestSeconds }
}

/** Options for one capability probe. */
export interface ProbeOptions {
  /** Normalized loopback base URL. */
  readonly baseUrl: string
  /** Resolved bearer credential, or null when the endpoint needs none. */
  readonly credential: string | null
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
  /** What that response proved about the credential. */
  readonly authenticated: SpeechRailAuthentication
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
    headers: {
      ...(options.credential === null ? {} : { authorization: `Bearer ${options.credential}` }),
      accept: 'application/json',
    },
    timeoutMs: options.timeoutMs ?? CAPABILITY_TIMEOUT_MS,
    maxResponseBytes: TRANSCRIPTION_RESPONSE_MAX_BYTES,
    signal: options.signal,
  })
  if (!result.ok) {
    // A response can arrive and still fail (a body over the cap, a stall after the
    // headers); `httpStatus` records that it did, so report reachability honestly. A
    // 404/405 that arrived with an unusable body still proves the endpoint is absent, so
    // that is classified from the status rather than from the failure the body produced.
    // A status head that arrived judges what it judges, whatever the body then did: a 401 whose
    // body was over the cap or stalled still proves the credential was refused, and a 404/405 still
    // proves the endpoint is absent. Only a status that judged nothing leaves the verdict open.
    const status = result.failure.httpStatus
    const absent = status === 404 || status === 405
    const refused = status === 401 || status === 403
    return {
      ok: false,
      reachable: status !== null,
      authenticated: refused ? 'refused' : 'unverified',
      failure: absent ? failure('capabilities-absent', { httpStatus: status }) : result.failure,
    }
  }
  if (result.status !== 200) {
    // Only 401/403 judge the credential. A 500/404/413 says nothing about it, so it must
    // report `unverified`: calling it `refused` would blame a credential nothing looked at,
    // and calling it `accepted` would turn any server error into "authorized".
    const authenticated: SpeechRailAuthentication = result.status === 401 || result.status === 403 ? 'refused' : 'unverified'
    // An engine that only transcribes answers 404/405/501 here. That is a usable service
    // that states no capabilities, not a broken one, so it gets its own code; the caller
    // then keeps `capabilities: null` instead of reporting a missing endpoint as a failure.
    // 404 and 405 only: 501 is a 5xx and stays a server error, retryable as before.
    const capabilitiesAbsent = result.status === 404 || result.status === 405
    return {
      ok: false,
      reachable: true,
      authenticated,
      failure: capabilitiesAbsent
        ? failure('capabilities-absent', { httpStatus: result.status })
        : failureForResponse(result.status, result.body),
    }
  }
  return { ok: true, capabilities: projectCapabilities(parseJson(result.body), options.previousLimits ?? null) }
}
