/**
 * Defensive projection of the untrusted SpeechRail capability snapshot.
 *
 * Nothing here trusts a field: an absent, mistyped or unexpected value degrades to
 * "unknown", and unknown language support never widens the language selector.
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
function projectLanguages(transcription: Record<string, unknown>): { readonly status: 'supported' | 'unknown'; readonly values: readonly string[] } {
  // A service that reports transcription as unsupported states nothing useful about
  // languages: admitting them would widen the selector for an endpoint that cannot
  // transcribe at all.
  if (transcription.status !== 'supported') return { status: 'unknown', values: [] }
  const languages = objectAt(transcription, 'languages')
  const raw = languages?.values
  if (languages?.status !== 'supported' || !Array.isArray(raw)) return { status: 'unknown', values: [] }
  const values = new Set<string>()
  for (const entry of raw) {
    if (typeof entry !== 'string') continue
    const token = entry.trim().toLowerCase()
    if (LANGUAGE_TOKEN.test(token)) values.add(token)
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
 * Two different "not stated" cases are treated differently on purpose:
 * - no snapshot is in force at all (never probed, endpoint absent, probe failed): nothing has
 *   spoken about languages, so the user's explicit choice is the only evidence there is and every
 *   known mode is offered, to be sent as an unverified hint;
 * - a snapshot that *did* answer but states no language domain: it spoke and said nothing usable,
 *   so only `auto` is offered, exactly as before.
 * @param view - projected capability facts, or null when none is in force.
 * @returns `auto` always, plus every known mode while no snapshot is in force.
 */
export function languageOptionsFor(view: SpeechRailCapabilitiesView | null): readonly SpeechRailLanguageMode[] {
    if (view === null) return ['auto', ...KNOWN_LANGUAGES]
    if (view.languages.status !== 'supported') return ['auto']
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
