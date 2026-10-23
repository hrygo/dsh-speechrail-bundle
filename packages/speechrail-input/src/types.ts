/**
 * Types that cross the Remote boundary.
 *
 * The Typert generator requires every Remote parameter and result type to come from
 * a public non-root type subpath (`./types`), so these declarations live here and
 * `contracts.ts` re-exports them for Host-internal use.
 * @module @hrygo/dsh-speechrail-bundle/types
 */

/** Configuration-driven language selection; `auto` omits the language field entirely. */
export type SpeechRailLanguageMode = 'auto' | 'zh' | 'en'

/** Whether one attempt failed for certain or may still be running remotely. */
export type SpeechRailOutcome = 'failed' | 'unknown'

/** Whether a new transcription may start, is running, or is blocked by an unproven outcome. */
export type SpeechRailGateState = 'ready' | 'busy' | 'unknown'

/** Closed failure vocabulary; the client localizes each code and nothing else travels. */
export type SpeechRailFailureCode =
  | 'endpoint-invalid'
  | 'not-configured'
  | 'bad-request'
  | 'audio-invalid'
  | 'unauthorized'
  | 'not-found'
  | 'model-not-found'
  | 'server-error'
  | 'unreachable'
  | 'timeout'
  | 'cancelled'
  | 'busy'
  | 'conflict'
  | 'unknown-outcome'
  | 'malformed-response'
  | 'journal-unavailable'
  | 'internal'

/** One sanitized failure: no response body, message, path, credential or transcript text. */
export interface SpeechRailFailure {
  /** Closed code the client maps to a localized message. */
  readonly code: SpeechRailFailureCode
  /** HTTP status when a response arrived; null otherwise. */
  readonly httpStatus: number | null
  /** Whether repeating the same intent could plausibly succeed. */
  readonly retryable: boolean
  /** Server-issued request id when the error body carried one. */
  readonly requestId: string | null
  /** Whether the remote outcome is known to have failed or is merely unproven. */
  readonly outcome: SpeechRailOutcome
}

/** Advertised language support, projected from the service snapshot. */
export interface SpeechRailLanguageView {
  /** `supported` only when the service enumerated concrete language values. */
  readonly status: 'supported' | 'unknown'
  /** Enumerated language values, lower-cased and de-duplicated. */
  readonly values: readonly string[]
}

/** Limits projected from the service snapshot, already clamped to this package's ceilings. */
export interface SpeechRailLimits {
  /** Admitted upload size in bytes. */
  readonly maxUploadBytes: number
  /** Admitted recording duration in seconds. */
  readonly maxAudioSeconds: number
}

/** Effective transcription facts read from one capability snapshot. */
export interface SpeechRailCapabilitiesView {
  /** Snapshot schema version reported by the service. */
  readonly schemaVersion: string | null
  /** Whether the service reports the transcription operation as supported. */
  readonly transcriptionSupported: boolean
  /** Service-reported readiness reason, already reduced to a short token or null. */
  readonly reason: string | null
  /** Advertised language support. */
  readonly languages: SpeechRailLanguageView
  /** Effective limits after clamping. */
  readonly limits: SpeechRailLimits
}

/** Everything the settings page and the composer control need to render. */
export interface SpeechRailInputStatus {
  /** Configured endpoint exactly as written, so the settings page can show and fix it. */
  readonly baseUrl: string
  /** Why the configured endpoint was refused, or null when it is usable. */
  readonly endpointProblem: string | null
  /** Optional explicit model id; an empty string means the service chooses. */
  readonly model: string
  /** Credential reference consulted for every operation. */
  readonly credentialRef: string
  /** Whether the credential currently resolves to a non-empty value. */
  readonly credentialConfigured: boolean
  /** Configured language mode. */
  readonly language: SpeechRailLanguageMode
  /** Language modes the capability snapshot currently admits. */
  readonly languageOptions: readonly SpeechRailLanguageMode[]
  /** One request budget in milliseconds. */
  readonly requestTimeoutMs: number
  /** Effective limits for the next recording. */
  readonly limits: SpeechRailLimits
  /** Current gate state. */
  readonly gate: SpeechRailGateState
  /** Operation id blocking the gate, when one is recorded. */
  readonly pendingOperationId: string | null
  /** Last capability snapshot, or null before the first successful check. */
  readonly capabilities: SpeechRailCapabilitiesView | null
  /** When the cached snapshot was taken, as an ISO string, or null. */
  readonly checkedAt: string | null
  /** Revision of the persisted settings namespace, for conflict-checked writes. */
  readonly revision: number
}

/** Result of one connectivity and capability probe. */
export interface SpeechRailCheckResult {
  /** Whether an HTTP response arrived from the configured endpoint. */
  readonly reachable: boolean
  /** Whether the probe was authorized. */
  readonly authenticated: boolean
  /** Fresh or cached capability facts, or null when the probe failed. */
  readonly capabilities: SpeechRailCapabilitiesView | null
  /** Failure of the probe itself, or null when it succeeded. */
  readonly failure: SpeechRailFailure | null
  /** When this check ran, as an ISO string. */
  readonly checkedAt: string
}

/** Strictly validated configuration payload carried as bounded JSON text. */
export interface SpeechRailConfigureRequest {
  /** Language mode to persist. */
  readonly language: SpeechRailLanguageMode
  /** Request budget to persist. */
  readonly requestTimeoutMs: number
  /** Revision the writer read; a mismatch fails the write. */
  readonly expectedRevision: number
}

/** Outcome of a configuration write. */
export interface SpeechRailConfigureResult {
  /** Whether the settings write succeeded. */
  readonly ok: boolean
  /** Revision after a successful write, or the current revision on failure. */
  readonly revision: number
  /** Present only when the write failed. */
  readonly failure: SpeechRailFailure | null
}

/** Strictly validated transcription payload carried as bounded JSON text. */
export interface SpeechRailTranscribeRequest {
  /** Client-generated operation id; recorded before the upload starts. */
  readonly operationId: string
  /** Canonical 16 kHz mono PCM16 WAV bytes, base64 with no data-URL prefix. */
  readonly audioBase64: string
}

/** One accepted transcript; the text is the only place audio content appears. */
export interface SpeechRailTranscript {
  /** Operation id this transcript answers. */
  readonly operationId: string
  /** Recognized text. */
  readonly text: string
  /** Recording duration measured from the validated WAV. */
  readonly audioSeconds: number
  /** Wall-clock duration of the HTTP request. */
  readonly requestSeconds: number
  /** Always null: SpeechRail reports no server-side inference timing. */
  readonly inferenceSeconds: null
}

/** Outcome of one transcription attempt. */
export interface SpeechRailTranscriptionResult {
  /** Whether a transcript was produced. */
  readonly ok: boolean
  /** Present only when ok. */
  readonly transcript: SpeechRailTranscript | null
  /** Present only when not ok. */
  readonly failure: SpeechRailFailure | null
}

/** Strictly validated acknowledgement of an unproven remote outcome. */
export interface SpeechRailAcknowledgeRequest {
  /** Operation id the user acknowledges as unproven. */
  readonly operationId: string
}

/** Result of acknowledging an unproven outcome. */
export interface SpeechRailAcknowledgeResult {
  /** Whether the acknowledgement matched the recorded pending operation. */
  readonly ok: boolean
  /** Operation id still blocking the gate, or null when the gate is clear. */
  readonly pendingOperationId: string | null
  /** Present only when the acknowledgement was rejected. */
  readonly failure: SpeechRailFailure | null
}
