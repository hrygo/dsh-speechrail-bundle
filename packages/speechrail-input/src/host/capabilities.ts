/**
 * Defensive projection of the untrusted SpeechRail capability snapshot.
 *
 * Nothing here trusts a field: an absent, mistyped or unexpected value degrades to
 * "unknown", and a snapshot that does not enumerate languages never decides one for the service: the
 * selector offers every known mode and the choice travels as an unverified hint.
 * @module @hrygo/dsh-speechrail-bundle/host/capabilities
 */

import {
  ABSOLUTE_MAX_AUDIO_SECONDS,
  ABSOLUTE_MAX_UPLOAD_BYTES,
  type SpeechRailCapabilitiesView,
  type SpeechRailLanguageMode,
  type SpeechRailLimits,
} from '../contracts.ts'
import { sanitizeReason } from './failure.ts'

/**
 * Limits enforced before any snapshot has been read: the package's own ceilings, so
 * nothing a service can legitimately advertise is refused on a guess. They are the
 * widest values this package accepts, not conservative ones.
 */
export const DEFAULT_LIMITS: SpeechRailLimits = {
  maxUploadBytes: ABSOLUTE_MAX_UPLOAD_BYTES,
  maxAudioSeconds: ABSOLUTE_MAX_AUDIO_SECONDS,
}

/** Language values the selector may admit, beyond the always-present automatic mode. */
const KNOWN_LANGUAGES: readonly SpeechRailLanguageMode[] = ['zh', 'en']

/** BCP-47-ish token shape admitted from the snapshot; anything else is ignored. */
const LANGUAGE_TOKEN = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/u

/**
 * Longest language token admitted from the snapshot.
 *
 * The shape above admits any number of subtags, so it cannot bound the token on its own, and the
 * token travels on: it becomes a selector entry and a line in the agent tool's report. Real BCP-47
 * tags are far shorter than this (`zh-Hans-CN`, `sr-Latn-RS`, `en-US-x-twain`), so the cap only
 * discards what no selector should ever show. The response body is bounded too, but at 256 KiB -
 * far more than any report should carry.
 */
const LANGUAGE_TOKEN_MAX_LENGTH = 24

/** Read a nested plain object property without trusting the container. */
function objectAt(value: unknown, key: string): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) return null
  const nested = (value as Record<string, unknown>)[key]
  if (typeof nested !== 'object' || nested === null || Array.isArray(nested)) return null
  return nested as Record<string, unknown>
}

/** Read a finite positive number, ignoring anything else. */
function positiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

/**
 * Clamp advertised limits to this package's absolute ceilings.
 *
 * A limit the snapshot does not state keeps the value already in force. Falling back
 * to the absolute ceiling here would widen what this host accepts whenever a service
 * recognises as a transcription endpoint without stating its input limits.
 * @param advertised - limits read from a snapshot, each possibly null when unstated.
 * @param previous - limits in force before this snapshot, if any.
 * @returns effective limits that never exceed the package ceilings.
 */
export function clampLimits(
  advertised: { readonly maxUploadBytes: number | null; readonly maxAudioSeconds: number | null },
  previous?: SpeechRailLimits | null,
): SpeechRailLimits {
  return {
    maxUploadBytes: Math.min(ABSOLUTE_MAX_UPLOAD_BYTES, positiveNumber(advertised.maxUploadBytes) ?? previous?.maxUploadBytes ?? ABSOLUTE_MAX_UPLOAD_BYTES),
    maxAudioSeconds: Math.min(ABSOLUTE_MAX_AUDIO_SECONDS, positiveNumber(advertised.maxAudioSeconds) ?? previous?.maxAudioSeconds ?? ABSOLUTE_MAX_AUDIO_SECONDS),
  }
}

/** Normalize an advertised language list into admitted values. */
function projectLanguages(transcription: Record<string, unknown>): { readonly status: 'supported' | 'unknown' | 'unsupported'; readonly values: readonly string[] } {
  // A service that reports transcription as unsupported states nothing useful about
  // languages: admitting them would widen the selector for an endpoint that cannot
  // transcribe at all.
  if (transcription.status !== 'supported') return { status: 'unknown', values: [] }
  const languages = objectAt(transcription, 'languages')
  // An explicit refusal is not the same statement as silence: the service said it takes no language
  // hint, so none may be invented for it.
  if (languages?.status === 'unsupported') return { status: 'unsupported', values: [] }
  const raw = languages?.values
  if (languages?.status !== 'supported' || !Array.isArray(raw)) return { status: 'unknown', values: [] }
  const values = new Set<string>()
  for (const entry of raw) {
    if (typeof entry !== 'string') continue
    const token = entry.trim().toLowerCase()
    if (token.length <= LANGUAGE_TOKEN_MAX_LENGTH && LANGUAGE_TOKEN.test(token)) values.add(token)
    if (values.size >= 32) break
  }
  return values.size === 0 ? { status: 'unknown', values: [] } : { status: 'supported', values: [...values] }
}

/**
 * Project the `transcription` operation of an `effective_capabilities_v1` snapshot.
 * @param snapshot - decoded response body, untrusted.
 * @returns the projected facts, or null when the body is not a usable snapshot.
 */
export function projectCapabilities(snapshot: unknown, previous?: SpeechRailLimits | null): SpeechRailCapabilitiesView | null {
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) return null
  const transcription = objectAt(objectAt(snapshot, 'operations'), 'transcription')
  if (transcription === null) return null
  const input = objectAt(transcription, 'input')
  const schemaVersion = (snapshot as Record<string, unknown>).schema_version
  return {
    schemaVersion: typeof schemaVersion === 'string' && schemaVersion.length <= 64 ? schemaVersion : null,
    transcriptionSupported: transcription.status === 'supported',
    reason: sanitizeReason(transcription.reason),
    languages: projectLanguages(transcription),
    limits: clampLimits({
      maxUploadBytes: positiveNumber(input?.max_upload_bytes),
      maxAudioSeconds: positiveNumber(input?.max_audio_seconds),
    }, previous),
  }
}

/**
 * Language modes the selector may offer for one snapshot.
 *
 * Three cases, and the distinction that matters is whether the endpoint can transcribe at all:
 * - it cannot (`transcriptionSupported === false`): only `auto`. The upload is refused before the
 *   audio leaves the host, so offering a hint would promise a choice that cannot be exercised;
 * - it can, and the snapshot enumerated languages: only the modes whose exact value it listed;
 * - it can, but nothing enumerated the languages (no snapshot at all, or a snapshot whose language
 *   domain is `unknown`): every known mode is offered and the chosen one travels as an unverified
 *   hint. SpeechRail itself answers this way -- its transcription endpoint documents `language` as
 *   a hint ("BCP-47-style or provider-compatible", example `zh`) while its capability snapshot
 *   states `languages.status: unknown` -- so refusing the choice here would lose a real capability.
 * @param view - projected capability facts, or null when none is in force.
 * @returns `auto` always, plus the modes worth offering.
 */
export function languageOptionsFor(view: SpeechRailCapabilitiesView | null): readonly SpeechRailLanguageMode[] {
  if (view === null) return ['auto', ...KNOWN_LANGUAGES]
  if (!view.transcriptionSupported) return ['auto']
  if (view.languages.status === 'unsupported') return ['auto']
  if (view.languages.status !== 'supported') return ['auto', ...KNOWN_LANGUAGES]
  const admitted = KNOWN_LANGUAGES.filter((mode) => view.languages.values.includes(mode))
  return ['auto', ...admitted]
}

/**
 * Decide whether a configured language mode may be sent.
 * @param mode - configured mode.
 * @param view - projected capability facts, or null.
 * @returns true when the mode is automatic or the snapshot admits it.
 */
export function languageIsAdmitted(mode: SpeechRailLanguageMode, view: SpeechRailCapabilitiesView | null): boolean {
  return mode === 'auto' || languageOptionsFor(view).includes(mode)
}
