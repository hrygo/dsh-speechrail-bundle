/**
 * Single-in-flight transcription engine, independent of Cordis and of the transport.
 *
 * Two invariants shape this file:
 * 1. The gate is claimed synchronously, before the first `await`, so two concurrent
 *    attempts can never both upload.
 * 2. A request byte is only written after the operation is recorded durably, so a
 *    reload can always tell the user that an outcome is unproven.
 * @module @hrygo/dsh-speechrail-bundle/host/core
 */

import {
  MAX_REQUEST_TIMEOUT_MS,
  MIN_REQUEST_TIMEOUT_MS,
  CONFIG_PAYLOAD_MAX_BYTES,
  TRANSCRIBE_PAYLOAD_MAX_BYTES,
  type SpeechRailAcknowledgeRequest,
  type SpeechRailAcknowledgeResult,
  type SpeechRailCapabilitiesView,
  type SpeechRailCheckResult,
  type SpeechRailConfigureRequest,
  type SpeechRailConfigureResult,
  type SpeechRailFailure,
  type SpeechRailGateState,
  type SpeechRailInputStatus,
  type SpeechRailLanguageMode,
  type SpeechRailLimits,
  type SpeechRailTranscribeRequest,
  type SpeechRailTranscriptionResult,
} from '../contracts.ts'
import { validateWave } from '../protocol/wave.ts'
import { DEFAULT_LIMITS, languageIsAdmitted, languageOptionsFor } from './capabilities.ts'
import { describeRefusal, type EndpointRefusal } from './endpoint.ts'
import { failure, unknownFailure } from './failure.ts'
import type { PendingJournal } from './journal.ts'
import type { ProbeOutcome, TranscribeOutcome } from './http.ts'

/** Effective configuration for one operation, read fresh so volatile updates apply. */
export interface ResolvedConfig {
  /**
   * Normalized loopback base URL, or an empty string when the endpoint is refused.
   * This is the only URL projection that may cross the Remote boundary, so any
   * userinfo an operator typed never reaches the client.
   */
  readonly baseUrl: string
  /** Why the endpoint is unusable, or null. */
  readonly endpointRefusal: EndpointRefusal | null
  /** Optional explicit model id; empty means the service chooses. */
  readonly model: string
  /** Credential reference resolved for every operation. */
  readonly credentialRef: string
  /** Configured language mode. */
  readonly language: SpeechRailLanguageMode
  /** One request budget in milliseconds. */
  readonly requestTimeoutMs: number
}

/** Transport and platform seams the engine depends on. */
export interface CoreDependencies {
  /** Current time. */
  readonly now: () => Date
  /** Read the effective configuration. */
  readonly config: () => ResolvedConfig
  /** Resolve a credential reference to a non-empty secret, or null. */
  readonly resolveCredential: (ref: string) => Promise<string | null>
  /** Durable pending-operation journal. */
  readonly journal: PendingJournal
  /** Upload one recording. */
  readonly transcribe: (options: {
    readonly baseUrl: string
    readonly model: string
    readonly language: string | null
    readonly credential: string
    readonly audio: Uint8Array
    readonly timeoutMs: number
    readonly signal?: AbortSignal | undefined
  }) => Promise<TranscribeOutcome>
  /** Probe the capability snapshot. */
  readonly probe: (options: { readonly baseUrl: string; readonly credential: string; readonly previousLimits?: SpeechRailLimits | null }) => Promise<ProbeOutcome>
  /** Current settings revision for this entry, or null when Settings is unavailable. */
  readonly settingsRevision: () => number | null
  /** Persist the editable subset of this entry. */
  readonly writeSettings: (
    patch: { readonly language: SpeechRailLanguageMode; readonly requestTimeoutMs: number },
    expectedRevision: number,
  ) => Promise<'ok' | 'conflict' | 'failed'>
}

/** One parsed payload, or the failure that refuses it. */
export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: SpeechRailFailure }

/** Client-generated operation ids this engine accepts. */
const OPERATION_ID = /^[A-Za-z0-9_-]{8,64}$/u

/** Standard base64 with padding; no data-URL prefix, no whitespace, no base64url alphabet. */
/** Code unit bounds of the standard base64 alphabet, compared as numbers rather than matched. */
const BASE64_DIGIT_LOW = 0x30
const BASE64_DIGIT_HIGH = 0x39
const BASE64_UPPER_LOW = 0x41
const BASE64_UPPER_HIGH = 0x5a
const BASE64_LOWER_LOW = 0x61
const BASE64_LOWER_HIGH = 0x7a
const BASE64_PLUS = 0x2b
const BASE64_SLASH = 0x2f

/**
 * Whether the text is standard base64 with padding.
 *
 * Equivalent to the pattern this replaced for every non-empty string (fuzzed, and enumerated over
 * small alphabets); it differs only for the empty string, which the pattern accepted and this
 * rejects - and which the caller rejected anyway.
 *
 * @param text - candidate base64 text.
 * @returns whether it is standard base64 with padding.
 */
function isBase64(text: string): boolean {
  if (text.length === 0 || text.length % 4 !== 0) return false
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0
  const body = text.length - padding
  for (let index = 0; index < body; index += 1) {
    const unit = text.charCodeAt(index)
    // A per-character regexp here cost about 65 ms for a near-ceiling take and ran twice per upload;
    // comparing code units costs about 12 ms and cannot backtrack.
    if (unit === BASE64_PLUS || unit === BASE64_SLASH) continue
    if (unit >= BASE64_DIGIT_LOW && unit <= BASE64_DIGIT_HIGH) continue
    if (unit >= BASE64_UPPER_LOW && unit <= BASE64_UPPER_HIGH) continue
    if (unit >= BASE64_LOWER_LOW && unit <= BASE64_LOWER_HIGH) continue
    return false
  }
  return true
}

/**
 * Decode a bounded JSON carrier.
 * @param text - raw carrier text.
 * @param maxBytes - maximum accepted UTF-8 size.
 * @returns the decoded value, or null when it is oversized or not JSON.
 */
function decodeCarrier(text: string, maxBytes: number): unknown {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > maxBytes) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/**
 * Accept exactly the declared keys, so an unknown field is a refusal rather than a silent drop.
 * @param value - decoded carrier.
 * @param keys - the complete accepted key set.
 * @returns the record when it has exactly those keys.
 */
function strictRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const own = Object.keys(record)
  if (own.length !== keys.length) return null
  for (const key of keys) if (!Object.hasOwn(record, key)) return null
  return record
}

/** Refuse one payload with a code the client can localize. */
function refuse<T>(code: Parameters<typeof failure>[0]): ParseResult<T> {
  return { ok: false, failure: failure(code) }
}

/**
 * Parse one transcription payload.
 * @param text - JSON carrier text.
 * @returns the validated request, or a refusal.
 */
export function parseTranscribeRequest(text: string): ParseResult<SpeechRailTranscribeRequest> {
  // A carrier that does not fit the transport is a size refusal, not a malformed request: the take is
  // what is too large, and "check the configuration" sends the user to the wrong place. Measured: the
  // carrier admits about 147 s of canonical audio, so without this the largest takes - the ones whose
  // whole point is that they were too long to send - were reported as a bad request.
  if (typeof text !== 'string') return refuse('bad-request')
  if (Buffer.byteLength(text, 'utf8') > TRANSCRIBE_PAYLOAD_MAX_BYTES) return refuse('audio-too-large')
  const record = strictRecord(decodeCarrier(text, TRANSCRIBE_PAYLOAD_MAX_BYTES), ['operationId', 'audioBase64'])
  if (record === null) return refuse('bad-request')
  const operationId = record.operationId
  const audioBase64 = record.audioBase64
  if (typeof operationId !== 'string' || !OPERATION_ID.test(operationId)) return refuse('bad-request')
  if (typeof audioBase64 !== 'string' || audioBase64 === '' || !isBase64(audioBase64)) return refuse('bad-request')
  return { ok: true, value: { operationId, audioBase64 } }
}

/**
 * Parse one configuration payload.
 * @param text - JSON carrier text.
 * @returns the validated request, or a refusal.
 */
export function parseConfigureRequest(text: string): ParseResult<SpeechRailConfigureRequest> {
  const record = strictRecord(decodeCarrier(text, CONFIG_PAYLOAD_MAX_BYTES), ['language', 'requestTimeoutMs', 'expectedRevision'])
  if (record === null) return refuse('bad-request')
  const language = record.language
  const timeout = record.requestTimeoutMs
  const revision = record.expectedRevision
  if (language !== 'auto' && language !== 'zh' && language !== 'en') return refuse('bad-request')
  // The schema bound is the only other place this range exists, and `settings.write`
  // validates shape and volatility rather than `min`/`max`: without this check an
  // out-of-range value is persisted, after which the entry fails to activate.
  if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < MIN_REQUEST_TIMEOUT_MS || timeout > MAX_REQUEST_TIMEOUT_MS) {
    return refuse('bad-request')
  }
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) return refuse('bad-request')
  return { ok: true, value: { language, requestTimeoutMs: timeout, expectedRevision: revision } }
}

/**
 * Parse one acknowledgement payload.
 * @param text - JSON carrier text.
 * @returns the validated request, or a refusal.
 */
export function parseAcknowledgeRequest(text: string): ParseResult<SpeechRailAcknowledgeRequest> {
  const record = strictRecord(decodeCarrier(text, CONFIG_PAYLOAD_MAX_BYTES), ['operationId'])
  if (record === null) return refuse('bad-request')
  const operationId = record.operationId
  // `null` is the "nothing identifiable is outstanding" acknowledgement used when the
  // stored record itself could not be read; anything else must be a shaped id.
  if (operationId !== null && (typeof operationId !== 'string' || !OPERATION_ID.test(operationId))) return refuse('bad-request')
  return { ok: true, value: { operationId } }
}

/**
 * Decode base64 that a caller has already validated.
 *
 * Scanning a near-ceiling take twice costs another ~12 ms of blocked event loop for nothing, and the
 * only in-repo caller passes the parser's own output.
 *
 * The length is a multiple of four and padding only follows data, so a validated string always
 * decodes to at least one byte; there is no empty result to report.
 *
 * @param value - base64 text the caller has validated.
 * @returns the decoded bytes.
 */
function decodeValidatedBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'))
}

/** The engine that owns the gate, the cache and the operation lifecycle. */
export class SpeechRailInputCore {
  // Kept against the operation that owns the gate, not as "the most recent failure": when a later
  // attempt is refused locally and its own settle cannot complete, the gate reopens on *that*
  // operation, and an unkeyed cause would then be reported as the reason for an attempt that never
  // reached the network.
  private unprovenFailure: { readonly operationId: string; readonly failure: SpeechRailFailure } | null = null
  private gateState: SpeechRailGateState = 'ready'
  private pendingOperationId: string | null = null
  private capabilities: SpeechRailCapabilitiesView | null = null
  private checkedAt: string | null = null
  /** The single probe in flight, if any; see `check()`. */
  private checkInFlight: Promise<SpeechRailCheckResult> | null = null
  /**
   * Whether the last journal read failed. It distinguishes "this host could not read
   * its medium" from "an upload's outcome is genuinely unproven", which must not be
   * reported as the same thing.
   */
  private journalUnreadable = false

  constructor(private readonly deps: CoreDependencies) {}

  /**
   * Read the journal before the service becomes reachable.
   *
   * A reload must not present an unproven earlier upload as "nothing happened".
   * @returns after the gate reflects the durable record.
   */
  async restore(): Promise<void> {
    const state = await this.deps.journal.read()
    this.journalUnreadable = !state.available
    if (!state.available) {
      this.gateState = 'unknown'
      this.pendingOperationId = null
      return
    }
    if (state.pending !== null) {
      this.gateState = 'unknown'
      this.pendingOperationId = state.pending.operationId
    }
  }

  /**
   * Re-read the journal after an unreadable medium, adopting whatever it now reports.
   * @returns after the gate reflects the readable record, if any.
   */
  private async reopenJournal(): Promise<void> {
    const observedGate = this.gateState
    const observedPending = this.pendingOperationId
    const state = await this.deps.journal.read()
    // Whether the medium is readable is always news, even when the gate or the record moved
    // meanwhile; skipping it would leave the next attempt diagnosing an unreadable medium as
    // an unproven outcome.
    this.journalUnreadable = !state.available
    // The read is asynchronous: another attempt may have healed the gate, the user may have
    // acknowledged the record, or a newer upload may have recorded a different one while it
    // was in flight. Applying a snapshot older than any of that would resurrect a gate or an
    // id nothing holds — and because clearing compares ids, that dead-ends acknowledgement.
    if (this.gateState !== observedGate || this.pendingOperationId !== observedPending) return
    if (!state.available) return
    if (state.pending === null) {
      this.gateState = 'ready'
      this.pendingOperationId = null
      return
    }
    this.gateState = 'unknown'
    this.pendingOperationId = state.pending.operationId
  }

  /**
   * The language hint the next upload will carry, or null when none will.
   *
   * `auto` never sends one, and a language the snapshot in force refused to admit is withheld
   * rather than guessed. This is the single source of truth for both the wire and the reported
   * state, so no caller can be told about a hint that will not travel.
   */
  private effectiveLanguageHint(config: ResolvedConfig): SpeechRailLanguageMode | null {
    if (config.language === 'auto') return null
    return languageIsAdmitted(config.language, this.capabilities) ? config.language : null
  }

  /**
   * Snapshot everything the UI renders.
   * @returns the current status, including whether the credential is configured.
   */
  async status(): Promise<SpeechRailInputStatus> {
    const config = this.deps.config()
    const credential = await this.deps.resolveCredential(config.credentialRef)
    const capabilities = this.capabilities
    return {
      baseUrl: config.baseUrl,
      endpointProblem: config.endpointRefusal === null ? null : describeRefusal(config.endpointRefusal),
      model: config.model,
      credentialRef: config.credentialRef,
      credentialConfigured: credential !== null,
      language: config.language,
      // One expression decides both this report and the wire, so the tool can never promise a hint
      // the upload would withhold.
      languageHint: this.effectiveLanguageHint(config) ?? '',
      transcriptionSupport: capabilities === null
        ? 'unknown'
        : capabilities.transcriptionSupported ? 'supported' : 'unsupported',
      languageOptions: languageOptionsFor(capabilities),
      requestTimeoutMs: config.requestTimeoutMs,
      limits: this.capabilities?.limits ?? DEFAULT_LIMITS,
      gate: this.gateState,
      pendingOperationId: this.pendingOperationId,
      // Derived from the gate rather than stored beside it, so an open gate can never report a cause
      // that no longer applies, however it was opened - and keyed to the pending operation, so a gate
      // reopened on a different one cannot inherit the previous cause.
      unprovenFailure: this.gateState === 'unknown' && this.pendingOperationId !== null
        && this.unprovenFailure?.operationId === this.pendingOperationId
        ? this.unprovenFailure.failure
        : null,
      capabilities,
      checkedAt: this.checkedAt,
      revision: this.deps.settingsRevision() ?? 0,
    }
  }

  /**
   * Probe the service and refresh the capability cache.
   *
   * A probe never changes the gate: a reachable service proves nothing about an
   * earlier upload whose outcome is still unproven.
   * @returns what the probe observed.
   */
  async check(): Promise<SpeechRailCheckResult> {
    // One probe at a time: concurrent checks used to race, letting an older probe that
    // resolved later overwrite the newer snapshot (and the limits stated in it). Every
    // caller waiting here observes the same committed result.
    const inFlight = this.checkInFlight
    if (inFlight !== null) return inFlight
    const running = this.probeOnce()
    this.checkInFlight = running
    try {
      return await running
    } finally {
      if (this.checkInFlight === running) this.checkInFlight = null
    }
  }

  private async probeOnce(): Promise<SpeechRailCheckResult> {
    const checkedAt = this.deps.now().toISOString()
    const config = this.deps.config()
    if (config.endpointRefusal !== null) {
      this.checkedAt = checkedAt
      // The cached snapshot stays in force, so report the same one this host enforces.
      // A refused endpoint never asked the service anything, so the credential is unjudged.
      return { reachable: false, authenticated: 'unverified', capabilities: this.capabilities, failure: failure('endpoint-invalid'), checkedAt }
    }
    const credential = await this.deps.resolveCredential(config.credentialRef)
    if (credential === null) {
      this.checkedAt = checkedAt
      return { reachable: false, authenticated: 'unverified', capabilities: this.capabilities, failure: failure('not-configured'), checkedAt }
    }
    const outcome = await this.deps.probe({
      baseUrl: config.baseUrl,
      credential,
      // A snapshot that recognises the endpoint but states no input limits inherits
      // the limits already in force instead of jumping to the absolute ceilings.
      previousLimits: this.capabilities?.limits ?? null,
    })
    this.checkedAt = checkedAt
    if (outcome.ok) {
      // A 200 whose body is not a recognizable snapshot must not discard the last
      // known limits: falling back to the absolute ceilings would silently widen what
      // this host accepts, and enforce nothing the service ever stated.
      if (outcome.capabilities !== null) this.capabilities = outcome.capabilities
      // A 200 on an authenticated request is the only evidence of acceptance available.
      return { reachable: true, authenticated: 'accepted', capabilities: this.capabilities, failure: null, checkedAt }
    }
    // A failed probe keeps the last snapshot on purpose: falling back to the
    // absolute ceilings here would silently widen what this host accepts after a
    // service that once advertised tighter limits became briefly unreachable. That holds
    // for a service that never advertised any (a `capabilities-absent` engine), where the
    // package defaults stay in force exactly as they do before the first probe.
    return {
      reachable: outcome.reachable,
      authenticated: outcome.authenticated,
      capabilities: this.capabilities,
      failure: outcome.failure,
      checkedAt,
    }
  }

  /**
   * Persist the editable configuration after a revision check.
   * @param text - JSON carrier text.
   * @returns the new revision, or a localized-code failure.
   */
  async configure(text: string): Promise<SpeechRailConfigureResult> {
    const revision = this.deps.settingsRevision()
    const parsed = parseConfigureRequest(text)
    if (!parsed.ok) return { ok: false, revision: revision ?? 0, failure: parsed.failure }
    if (revision === null) return { ok: false, revision: 0, failure: failure('internal') }
    if (parsed.value.expectedRevision !== revision) return { ok: false, revision, failure: failure('conflict') }
    const written = await this.deps.writeSettings({
      language: parsed.value.language,
      requestTimeoutMs: parsed.value.requestTimeoutMs,
    }, revision)
    if (written === 'conflict') return { ok: false, revision: this.deps.settingsRevision() ?? revision, failure: failure('conflict') }
    if (written === 'failed') return { ok: false, revision, failure: failure('internal') }
    return { ok: true, revision: this.deps.settingsRevision() ?? revision + 1, failure: null }
  }

  /**
   * Claim the gate synchronously; this must run before any `await`.
   * @param operationId - operation claiming the gate.
   * @returns whether the claim succeeded, and why it did not.
   */
  private claim(operationId: string): { readonly ok: true } | { readonly ok: false; readonly failure: SpeechRailFailure } {
    if (this.gateState === 'busy') return { ok: false, failure: failure('busy') }
    if (this.gateState === 'unknown') {
      return { ok: false, failure: unknownFailure(this.journalUnreadable ? 'journal-unavailable' : 'unknown-outcome') }
    }
    // A new operation owns the gate from here, and the previous holder's cause is not attributable to
    // it - even when a client reuses the same operation id. Clearing on refusal would be wrong: a
    // refusal happens *because* the gate is still held, and that cause is exactly what a report needs.
    this.unprovenFailure = null
    this.gateState = 'busy'
    this.pendingOperationId = operationId
    return { ok: true }
  }

  /**
   * Release the gate after a proven outcome, keeping it closed when the journal cannot.
   * @param operationId - operation that owns the gate.
   * @returns after the gate and journal agree.
   */
  private async settleKnown(operationId: string): Promise<void> {
    const cleared = await this.deps.journal.clear(operationId)
    if (!cleared) {
      const state = await this.deps.journal.read()
      this.gateState = 'unknown'
      this.pendingOperationId = state.available && state.pending !== null ? state.pending.operationId : operationId
      return
    }
    if (this.pendingOperationId === operationId) {
      this.gateState = 'ready'
      this.pendingOperationId = null
    }
  }

  /**
   * Close the gate because the remote outcome could not be proven.
   * @param operationId - operation whose outcome is unproven.
   * @returns after the durable record and the gate agree.
   */
  private async adoptUnknown(operationId: string): Promise<void> {
    this.gateState = 'unknown'
    this.pendingOperationId = operationId
    await this.deps.journal.record({
      operationId,
      phase: 'unknown',
      createdAt: this.deps.now().toISOString(),
    })
  }

  /**
   * Upload one recording and return its transcript.
   * @param text - JSON carrier text of a {@link SpeechRailTranscribeRequest}.
   * @param signal - caller cancellation; it never replays or resumes the upload.
   * @returns the transcript, or a sanitized failure.
   */
  async transcribe(text: string, signal?: AbortSignal | undefined): Promise<SpeechRailTranscriptionResult> {
    // A parser that throws would surface as a Remote-level error the page cannot localize, and the
    // one input large enough to do it is a long recording - which is exactly a case the user needs
    // explained rather than a stack trace. The scan above removed the known cause; this keeps any
    // future one inside the closed failure vocabulary.
    let parsed: ParseResult<SpeechRailTranscribeRequest>
    try {
      parsed = parseTranscribeRequest(text)
    } catch {
      parsed = refuse('bad-request')
    }
    if (!parsed.ok) return { ok: false, transcript: null, failure: parsed.failure }
    // A medium that could not be opened at boot may be available now. Without this
    // re-read a transient storage failure would disable every upload until the user
    // acknowledged a record that never existed; only the unreadable variant is retried,
    // never a genuinely unproven outcome.
    if (this.gateState === 'unknown' && this.journalUnreadable) await this.reopenJournal()
    const claim = this.claim(parsed.value.operationId)
    if (!claim.ok) return { ok: false, transcript: null, failure: claim.failure }
    const result = await this.run(parsed.value, signal)
    // Record only what the gate cannot explain about itself: an attempt that claimed the gate and then
    // left its outcome unproven. A settled refusal is not why the gate is closed, and the refusal a
    // *closed* gate hands back ("an earlier attempt is unconfirmed") is its consequence, not its cause.
    const failure = result.failure
    if (result.ok) this.unprovenFailure = null
    else if (failure !== null && failure.outcome === 'unknown') {
      this.unprovenFailure = { operationId: parsed.value.operationId, failure }
    }
    return result
  }

  /** Finish one claimed operation, from validation to settlement. */
  private async run(request: SpeechRailTranscribeRequest, signal?: AbortSignal | undefined): Promise<SpeechRailTranscriptionResult> {
    const config = this.deps.config()
    // No `unproven` flag: a refusal here settles the journal, so it must also be reported as settled.
    // A flag would have let the gate and the message disagree.
    const refuse = async (code: Parameters<typeof failure>[0]): Promise<SpeechRailTranscriptionResult> => {
      await this.settleKnown(request.operationId)
      return { ok: false, transcript: null, failure: failure(code) }
    }
    if (config.endpointRefusal !== null) return await refuse('endpoint-invalid')

    const audio = decodeValidatedBase64(request.audioBase64)
    // The service stated that it cannot transcribe: refuse before uploading anything.
    // A null snapshot states nothing, so it is not treated as a refusal.
    if (this.capabilities !== null && !this.capabilities.transcriptionSupported) return await refuse('unsupported')
    const limits = this.capabilities?.limits ?? DEFAULT_LIMITS
    const validated = validateWave(audio, limits.maxAudioSeconds)
    // A recording the service would have refused for its length or size is not a malformed
    // recording. Naming the real reason lets the user shorten the take instead of wondering about a
    // format the browser produced correctly, and it is the honest report of a local ceiling that is
    // deliberately stricter than the service's own (4 MiB / 120 s against an advertised 512 MiB /
    // 3600 s, because a whole take travels as one base64 JSON carrier).
    if (!validated.ok) return await refuse(validated.reason === 'too-long' ? 'audio-too-long' : 'audio-invalid')
    if (validated.byteLength > limits.maxUploadBytes) return await refuse('audio-too-large')

    const state = await this.deps.journal.read()
    this.journalUnreadable = !state.available
    if (!state.available) return await refuse('journal-unavailable')
    if (state.pending !== null) {
      await this.adoptUnknown(state.pending.operationId)
      return { ok: false, transcript: null, failure: unknownFailure('unknown-outcome') }
    }
    const recorded = await this.deps.journal.record({
      operationId: request.operationId,
      phase: 'pending',
      createdAt: this.deps.now().toISOString(),
    })
    if (!recorded) return await refuse('journal-unavailable')

    const credential = await this.deps.resolveCredential(config.credentialRef)
    if (credential === null) return await refuse('not-configured')

    const language = this.effectiveLanguageHint(config)
    const outcome = await this.deps.transcribe({
      baseUrl: config.baseUrl,
      model: config.model,
      language,
      credential,
      audio,
      timeoutMs: config.requestTimeoutMs,
      signal,
    })
    if (outcome.ok) {
      await this.settleKnown(request.operationId)
      return {
        ok: true,
        transcript: {
          operationId: request.operationId,
          text: outcome.text,
          audioSeconds: validated.seconds,
          requestSeconds: outcome.requestSeconds,
          inferenceSeconds: null,
        },
        failure: null,
      }
    }
    if (outcome.failure.outcome === 'unknown') {
      await this.adoptUnknown(request.operationId)
      return { ok: false, transcript: null, failure: outcome.failure }
    }
    await this.settleKnown(request.operationId)
    return { ok: false, transcript: null, failure: outcome.failure }
  }

  /**
   * Clear an unproven outcome that the user has explicitly acknowledged.
   * @param text - JSON carrier text of a {@link SpeechRailAcknowledgeRequest}.
   * @returns the remaining pending operation, or a refusal.
   */
  async acknowledgeUnknown(text: string): Promise<SpeechRailAcknowledgeResult> {
    const parsed = parseAcknowledgeRequest(text)
    if (!parsed.ok) {
      return { ok: false, pendingOperationId: this.pendingOperationId, failure: parsed.failure }
    }
    if (this.gateState !== 'unknown') {
      return { ok: true, pendingOperationId: this.pendingOperationId, failure: null }
    }
    if (parsed.value.operationId === null) {
      // A null id means "the stored record could not be read". If this host is holding
      // an id, a readable record exists after all, so the concrete id must be matched
      // instead: resetting here would erase a real unproven upload.
      if (this.pendingOperationId !== null) {
        return { ok: false, pendingOperationId: this.pendingOperationId, failure: failure('conflict') }
      }
      // The record looked unreadable at restore, but that read may have failed
      // transiently. Re-read before erasing: without this check a momentary failure
      // would destroy a record that is readable now.
      const reread = await this.deps.journal.read()
      // The read is asynchronous: an upload may have healed the gate, claimed it and
      // recorded its operation while it was in flight. Deciding on the state read before it
      // would answer with a conflict over that live upload (the erase itself is prevented
      // further down, which refuses to run while a readable record exists).
      if (this.gateState !== 'unknown' || this.pendingOperationId !== null) {
        return { ok: true, pendingOperationId: this.pendingOperationId, failure: null }
      }
      if (reread.available && reread.pending !== null) {
        this.pendingOperationId = reread.pending.operationId
        return { ok: false, pendingOperationId: reread.pending.operationId, failure: failure('conflict') }
      }
      const reset = await this.deps.journal.reset()
      if (!reset) {
        // A refusal is not the same as a failure: the slot may hold a readable record that
        // appeared after this request's read failed (the medium failing to open once does
        // not mean it is unreadable now). Adopting that id is the honest answer, and it is
        // the only one that lets the user complete the acknowledgement in one action.
        const settled = await this.deps.journal.read()
        if (this.gateState !== 'unknown' || this.pendingOperationId !== null) {
          return { ok: true, pendingOperationId: this.pendingOperationId, failure: null }
        }
        if (settled.available && settled.pending !== null) {
          this.pendingOperationId = settled.pending.operationId
          return { ok: false, pendingOperationId: settled.pending.operationId, failure: failure('conflict') }
        }
        return { ok: false, pendingOperationId: this.pendingOperationId, failure: failure('journal-unavailable') }
      }
      // `reset` refuses while a readable record exists, so reaching here means the slot was
      // empty or unreadable; the gate is only opened if nothing else took it meanwhile.
      if (this.gateState !== 'unknown' || this.pendingOperationId !== null) {
        return { ok: true, pendingOperationId: this.pendingOperationId, failure: null }
      }
      this.gateState = 'ready'
      this.pendingOperationId = null
      return { ok: true, pendingOperationId: null, failure: null }
    }
    if (this.pendingOperationId !== parsed.value.operationId) {
      return { ok: false, pendingOperationId: this.pendingOperationId, failure: failure('conflict') }
    }
    const cleared = await this.deps.journal.clear(parsed.value.operationId)
    if (!cleared) {
      return { ok: false, pendingOperationId: this.pendingOperationId, failure: failure('journal-unavailable') }
    }
    // The clear is asynchronous: an upload can heal the gate, claim it and record its own
    // operation while it is in flight. Only open the gate when this id still owns it.
    if (this.gateState !== 'unknown' || (this.pendingOperationId !== null && this.pendingOperationId !== parsed.value.operationId)) {
      return { ok: true, pendingOperationId: this.pendingOperationId, failure: null }
    }
    this.gateState = 'ready'
    this.pendingOperationId = null
    return { ok: true, pendingOperationId: null, failure: null }
  }
}
