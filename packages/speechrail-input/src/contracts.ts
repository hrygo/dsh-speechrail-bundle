/**
 * Public vocabulary shared by the Host service, the Remote surface and the client UI.
 *
 * Every type here crosses the Remote boundary, so it stays inside the JSON subset the
 * Typert generator can project: scalars, readonly arrays, string-literal unions, and
 * nullable fields. No Dates, class instances, or dictionaries with unknown values.
 * @module @hrygo/dsh-speechrail-bundle
 */

/** Package identity used by the Loader patch, the Remote namespace and the client bundle. */
export const PACKAGE_NAME = '@hrygo/dsh-speechrail-bundle'

/** Loader entry id declared by this bundle's patch. */
export const BUNDLE_ENTRY_ID = 'speechrail-input'

/** Remote namespace that carries the client-facing methods. */
export const REMOTE_NAMESPACE = 'speechrailInput'

/** Default endpoint of the local SpeechRail service. */
export const DEFAULT_BASE_URL = 'http://127.0.0.1:8201/v1'

/** Credential reference read for every operation; never persisted by this package. */
export const DEFAULT_CREDENTIAL_REF = 'SPEECHRAIL_API_KEY'

/** One request budget covering connect, upload, inference and download. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 150_000

/** Smallest accepted request budget. */
export const MIN_REQUEST_TIMEOUT_MS = 1_000

/** Largest accepted request budget. */
export const MAX_REQUEST_TIMEOUT_MS = 180_000

/** Absolute upload ceiling this package enforces regardless of the advertised service limit. */
export const ABSOLUTE_MAX_UPLOAD_BYTES = 4 * 1024 * 1024

/** Absolute recording ceiling this package enforces regardless of the advertised service limit. */
export const ABSOLUTE_MAX_AUDIO_SECONDS = 120

/** Largest accepted configuration payload, in bytes of UTF-8 JSON text. */
export const CONFIG_PAYLOAD_MAX_BYTES = 8_192

/** Largest accepted transcription payload, in bytes of UTF-8 JSON text. */
export const TRANSCRIBE_PAYLOAD_MAX_BYTES = 6_291_456

/** Largest accepted transcription response body, in bytes. */
export const TRANSCRIPTION_RESPONSE_MAX_BYTES = 262_144

/** Budget for one capability probe, which must never hold the transcription gate. */
export const CAPABILITY_TIMEOUT_MS = 5_000

export type * from './types.ts'

/**
 * Every failure code as runtime data, exhaustively checked against the union: the
 * `Record` type makes the compiler demand a key for each code, and the client test
 * then proves both dictionaries carry copy for every one of them.
 */
const FAILURE_CODE_TABLE: Record<import('./types.ts').SpeechRailFailureCode, true> = {
  'endpoint-invalid': true,
  'not-configured': true,
  'bad-request': true,
  'audio-invalid': true,
  unauthorized: true,
  'not-found': true,
  'capabilities-absent': true,
  unsupported: true,
  'model-not-found': true,
  'server-error': true,
  unreachable: true,
  timeout: true,
  cancelled: true,
  busy: true,
  conflict: true,
  'unknown-outcome': true,
  'malformed-response': true,
  'journal-unavailable': true,
  internal: true,
}

/** Closed failure vocabulary shared with the client dictionaries. */
export const SPEECHRAIL_FAILURE_CODES = Object.keys(FAILURE_CODE_TABLE) as readonly import('./types.ts').SpeechRailFailureCode[]
