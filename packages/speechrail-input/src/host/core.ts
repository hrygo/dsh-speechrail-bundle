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
  readonly probe: (options: { readonly baseUrl: string; readonly credential: string }) => Promise<ProbeOutcome>
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
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u

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
  const record = strictRecord(decodeCarrier(text, TRANSCRIBE_PAYLOAD_MAX_BYTES), ['operationId', 'audioBase64'])
  if (record === null) return refuse('bad-request')
  const operationId = record.operationId
  const audioBase64 = record.audioBase64
  if (typeof operationId !== 'string' || !OPERATION_ID.test(operationId)) return refuse('bad-request')
  if (typeof audioBase64 !== 'string' || audioBase64 === '' || !BASE64.test(audioBase64)) return refuse('bad-request')
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
  if (typeof timeout !== 'number' || !Number.isInteger(timeout)) return refuse('bad-request')
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
 * Decode standard base64 into bytes.
 * @param value - validated base64 text.
 * @returns the decoded bytes, or null when the length is inconsistent.
 */
export function decodeBase64Audio(value: string): Uint8Array | null {
  if (!BASE64.test(value) || value.length % 4 !== 0) return null
  const bytes = Buffer.from(value, 'base64')
  return bytes.byteLength === 0 ? null : new Uint8Array(bytes)
}

/** The engine that owns the gate, the cache and the operation lifecycle. */
export class SpeechRailInputCore {
  private gateState: SpeechRailGateState = 'ready'
  private pendingOperationId: string | null = null
  private capabilities: SpeechRailCapabilitiesView | null = null
  private checkedAt: string | null = null

  constructor(private readonly deps: CoreDependencies) {}

  /**
   * Read the journal before the service becomes reachable.
   *
   * A reload must not present an unproven earlier upload as "nothing happened".
   * @returns after the gate reflects the durable record.
   */
  async restore(): Promise<void> {
    const state = await this.deps.journal.read()
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
   * Snapshot everything the UI renders.
   * @returns the current status, including whether the credential is configured.
   */
  async status(): Promise<SpeechRailInputStatus> {
    const config = this.deps.config()
    const credential = await this.deps.resolveCredential(config.credentialRef)
    return {
      baseUrl: config.baseUrl,
      endpointProblem: config.endpointRefusal === null ? null : describeRefusal(config.endpointRefusal),
      model: config.model,
      credentialRef: config.credentialRef,
      credentialConfigured: credential !== null,
      language: config.language,
      languageOptions: languageOptionsFor(this.capabilities),
      requestTimeoutMs: config.requestTimeoutMs,
      limits: this.capabilities?.limits ?? DEFAULT_LIMITS,
      gate: this.gateState,
      pendingOperationId: this.pendingOperationId,
      capabilities: this.capabilities,
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
    const checkedAt = this.deps.now().toISOString()
    const config = this.deps.config()
    if (config.endpointRefusal !== null) {
      this.checkedAt = checkedAt
      return { reachable: false, authenticated: false, capabilities: null, failure: failure('endpoint-invalid'), checkedAt }
    }
    const credential = await this.deps.resolveCredential(config.credentialRef)
    if (credential === null) {
      this.checkedAt = checkedAt
      return { reachable: false, authenticated: false, capabilities: this.capabilities, failure: failure('not-configured'), checkedAt }
    }
    const outcome = await this.deps.probe({ baseUrl: config.baseUrl, credential })
    this.checkedAt = checkedAt
    if (outcome.ok) {
      this.capabilities = outcome.capabilities
      return { reachable: true, authenticated: true, capabilities: outcome.capabilities, failure: null, checkedAt }
    }
    // A failed probe keeps the last snapshot on purpose: falling back to the
    // absolute ceilings here would silently widen what this host accepts after a
    // service that once advertised tighter limits became briefly unreachable.
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
    if (this.gateState === 'unknown') return { ok: false, failure: unknownFailure('unknown-outcome') }
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
    const parsed = parseTranscribeRequest(text)
    if (!parsed.ok) return { ok: false, transcript: null, failure: parsed.failure }
    const claim = this.claim(parsed.value.operationId)
    if (!claim.ok) return { ok: false, transcript: null, failure: claim.failure }
    return await this.run(parsed.value, signal)
  }

  /** Finish one claimed operation, from validation to settlement. */
  private async run(request: SpeechRailTranscribeRequest, signal?: AbortSignal | undefined): Promise<SpeechRailTranscriptionResult> {
    const config = this.deps.config()
    const refuse = async (code: Parameters<typeof failure>[0], unproven = false): Promise<SpeechRailTranscriptionResult> => {
      await this.settleKnown(request.operationId)
      return { ok: false, transcript: null, failure: unproven ? unknownFailure(code) : failure(code) }
    }
    if (config.endpointRefusal !== null) return await refuse('endpoint-invalid')

    const audio = decodeBase64Audio(request.audioBase64)
    if (audio === null) return await refuse('audio-invalid')
    const limits = this.capabilities?.limits ?? DEFAULT_LIMITS
    const validated = validateWave(audio, limits.maxAudioSeconds)
    if (!validated.ok || validated.byteLength > limits.maxUploadBytes) return await refuse('audio-invalid')

    const state = await this.deps.journal.read()
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

    const language = config.language !== 'auto' && languageIsAdmitted(config.language, this.capabilities)
      ? config.language
      : null
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
      // The stored record was unreadable, so there is no id to match. The user is
      // asserting that no upload of theirs is outstanding; a medium that cannot be
      // written still refuses, so the gate cannot be cleared blind.
      const reset = await this.deps.journal.reset()
      if (!reset) {
        return { ok: false, pendingOperationId: this.pendingOperationId, failure: failure('journal-unavailable') }
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
    this.gateState = 'ready'
    this.pendingOperationId = null
    return { ok: true, pendingOperationId: null, failure: null }
  }
}
