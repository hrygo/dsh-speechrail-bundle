/**
 * Loopback-only endpoint normalization for the local SpeechRail service.
 * @module dsh-voice-input/host/endpoint
 */

/** Why a configured endpoint was refused. */
export type EndpointRefusal =
  | 'not-a-url'
  | 'insecure-scheme'
  | 'not-loopback'
  | 'has-credentials'
  | 'has-query'
  | 'has-fragment'
  | 'wrong-path'

/** Accepted endpoint: the exact base URL every request is built from. */
export interface EndpointAccepted {
  /** Whether the value was accepted. */
  readonly ok: true
  /** Normalized base URL ending in `/v1`, with no trailing slash. */
  readonly baseUrl: string
  /** Request origin this endpoint resolves to, for diagnostics only. */
  readonly origin: string
}

/** Refused endpoint. */
export interface EndpointRejected {
  /** Whether the value was accepted. */
  readonly ok: false
  /** Stable machine-readable refusal reason. */
  readonly reason: EndpointRefusal
}

/** Result of normalizing one configured endpoint. */
export type EndpointResult = EndpointAccepted | EndpointRejected

/** Loopback host literals this package admits; DNS names are never resolved. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', '::1'])

/**
 * Normalize a configured SpeechRail endpoint, refusing anything that is not a plain
 * HTTP loopback address with the exact `/v1` base path.
 *
 * Loopback-only is a security property, not a preference: the credential is a local
 * bearer secret and must never travel to a remote or proxied destination.
 * @param input - raw configured endpoint.
 * @returns the normalized base URL, or the reason it was refused.
 */
export function normalizeEndpoint(input: string): EndpointResult {
  const text = input.trim()
  if (text === '') return { ok: false, reason: 'not-a-url' }
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return { ok: false, reason: 'not-a-url' }
  }
  if (url.protocol !== 'http:') return { ok: false, reason: 'insecure-scheme' }
  if (!LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) return { ok: false, reason: 'not-loopback' }
  if (url.username !== '' || url.password !== '') return { ok: false, reason: 'has-credentials' }
  if (url.search !== '') return { ok: false, reason: 'has-query' }
  if (url.hash !== '') return { ok: false, reason: 'has-fragment' }
  const path = url.pathname.replace(/\/+$/u, '')
  if (path !== '/v1') return { ok: false, reason: 'wrong-path' }
  return { ok: true, baseUrl: `${url.protocol}//${url.host}/v1`, origin: `${url.protocol}//${url.host}` }
}

/**
 * Human-readable refusal text. It names only the refusal kind, never the configured
 * value, and this is what the status projection sends to clients as
 * `endpointProblem`.
 */
export function describeRefusal(reason: EndpointRefusal): string {
  switch (reason) {
    case 'not-a-url':
      return 'The SpeechRail base URL is not a valid absolute URL'
    case 'insecure-scheme':
      return 'The SpeechRail base URL must use http on a loopback address'
    case 'not-loopback':
      return 'The SpeechRail base URL must point at 127.0.0.1 or ::1'
    case 'has-credentials':
      return 'The SpeechRail base URL must not embed credentials'
    case 'has-query':
      return 'The SpeechRail base URL must not carry a query string'
    case 'has-fragment':
      return 'The SpeechRail base URL must not carry a fragment'
    case 'wrong-path':
      return 'The SpeechRail base URL path must be exactly /v1'
  }
}
