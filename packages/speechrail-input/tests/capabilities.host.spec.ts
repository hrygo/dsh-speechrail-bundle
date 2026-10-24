import { describe, expect, it } from 'vitest'
import { ABSOLUTE_MAX_AUDIO_SECONDS, ABSOLUTE_MAX_UPLOAD_BYTES } from '../src/contracts.ts'
import {
  clampLimits,
  languageIsAdmitted,
  languageOptionsFor,
  projectCapabilities,
} from '../src/host/capabilities.ts'

/** One realistic `effective_capabilities_v1` body with the transcription operation present. */
function snapshot(transcription: Record<string, unknown>): unknown {
  return {
    schema_version: 'effective_capabilities_v1',
    service_instance_epoch: 'epoch-1',
    profile: 'quality/quality',
    operations: { transcription, tts_text_planner: { status: 'supported' } },
  }
}

const SUPPORTED = {
  status: 'supported',
  reason: null,
  input: { max_upload_bytes: 8_388_608, max_audio_seconds: 600 },
  granularity: 'segment',
  languages: { status: 'supported', values: ['zh', 'en'] },
  output: { formats: ['json', 'text'], word_timestamps: false },
  terminal_evidence: 'transcription.completed',
}

describe('projectCapabilities', () => {
  it('projects the transcription operation and clamps advertised limits', () => {
    expect(projectCapabilities(snapshot(SUPPORTED))).toEqual({
      schemaVersion: 'effective_capabilities_v1',
      transcriptionSupported: true,
      reason: null,
      languages: { status: 'supported', values: ['zh', 'en'] },
      limits: { maxUploadBytes: ABSOLUTE_MAX_UPLOAD_BYTES, maxAudioSeconds: ABSOLUTE_MAX_AUDIO_SECONDS },
    })
  })

  it('keeps smaller advertised limits instead of widening them', () => {
    const view = projectCapabilities(snapshot({ ...SUPPORTED, input: { max_upload_bytes: 1_048_576, max_audio_seconds: 30 } }))
    expect(view?.limits).toEqual({ maxUploadBytes: 1_048_576, maxAudioSeconds: 30 })
  })

  it('reports unsupported transcription with a sanitized reason token', () => {
    const view = projectCapabilities(snapshot({
      ...SUPPORTED,
      status: 'unsupported',
      reason: 'asr_not_ready',
    }))
    expect(view?.transcriptionSupported).toBe(false)
    expect(view?.reason).toBe('asr_not_ready')
  })

  it('drops an implausible reason instead of forwarding untrusted text', () => {
    const view = projectCapabilities(snapshot({
      ...SUPPORTED,
      status: 'unsupported',
      reason: 'ASR failed: /opt/models is missing',
    }))
    expect(view?.reason).toBeNull()
  })

  it('offers every known language when the service transcribes but lists none', () => {
    // SpeechRail's own shape: the snapshot says `languages.status: unknown` while its transcription
    // endpoint documents `language` as a hint. The choice is offered and travels unverified.
    const view = projectCapabilities(snapshot({ ...SUPPORTED, languages: { status: 'unknown', values: [] } }))
    expect(view?.languages).toEqual({ status: 'unknown', values: [] })
    expect(languageOptionsFor(view)).toEqual(['auto', 'zh', 'en'])
    expect(languageIsAdmitted('zh', view)).toBe(true)
    expect(languageIsAdmitted('en', view)).toBe(true)
    // The facts are still reported as unknown: nothing claims the service supports them.
    expect(languageOptionsFor(null)).toEqual(['auto', 'zh', 'en'])
    expect(languageIsAdmitted('zh', null)).toBe(true)
  })

  it('keeps an explicit language refusal distinct from silence', () => {
    // The service said it takes no language hint. Folding that into `unknown` would make the
    // selector offer a hint the service refused; the two statements are now kept apart.
    const view = projectCapabilities(snapshot({ ...SUPPORTED, languages: { status: 'unsupported', values: [] } }))
    expect(view?.languages).toEqual({ status: 'unsupported', values: [] })
    expect(languageOptionsFor(view)).toEqual(['auto'])
    expect(languageIsAdmitted('zh', view)).toBe(false)
  })

  it('offers no language at all for an endpoint that cannot transcribe', () => {
    // Nothing can be exercised here: the upload is refused before the audio leaves the host, so a
    // language hint would promise a choice the endpoint cannot honour.
    const view = projectCapabilities(snapshot({ ...SUPPORTED, status: 'unsupported', languages: undefined }))
    expect(view?.transcriptionSupported).toBe(false)
    expect(languageOptionsFor(view)).toEqual(['auto'])
    expect(languageIsAdmitted('zh', view)).toBe(false)
  })

  it('admits only the exact values an enumerated list named', () => {
    const view = projectCapabilities(snapshot({ ...SUPPORTED, languages: { status: 'supported', values: ['en'] } }))
    expect(languageOptionsFor(view)).toEqual(['auto', 'en'])
    expect(languageIsAdmitted('en', view)).toBe(true)
    expect(languageIsAdmitted('zh', view)).toBe(false)
  })

  it('drops malformed language entries and de-duplicates the rest', () => {
    const view = projectCapabilities(snapshot({
      ...SUPPORTED,
      languages: { status: 'supported', values: ['ZH', 'zh', 'en-US', 7, '', 'x'.repeat(200)] },
    }))
    expect(view?.languages).toEqual({ status: 'supported', values: ['zh', 'en-us'] })
  })

  it('accepts only the language modes this package can send', () => {
    const view = projectCapabilities(snapshot({ ...SUPPORTED, languages: { status: 'supported', values: ['ja'] } }))
    expect(languageOptionsFor(view)).toEqual(['auto'])
    expect(languageIsAdmitted('zh', view)).toBe(false)

    const bilingual = projectCapabilities(snapshot({ ...SUPPORTED, languages: { status: 'supported', values: ['zh', 'en'] } }))
    expect(languageOptionsFor(bilingual)).toEqual(['auto', 'zh', 'en'])
    expect(languageIsAdmitted('zh', bilingual)).toBe(true)
  })

  it('returns null for bodies that are not capability snapshots', () => {
    expect(projectCapabilities(null)).toBeNull()
    expect(projectCapabilities('effective_capabilities_v1')).toBeNull()
    expect(projectCapabilities([])).toBeNull()
    expect(projectCapabilities({ schema_version: 'effective_capabilities_v1' })).toBeNull()
    expect(projectCapabilities({ operations: { transcription: 'supported' } })).toBeNull()
  })

  it('defaults missing limits to the package ceilings', () => {
    expect(clampLimits({ maxUploadBytes: null, maxAudioSeconds: null })).toEqual({
      maxUploadBytes: ABSOLUTE_MAX_UPLOAD_BYTES,
      maxAudioSeconds: ABSOLUTE_MAX_AUDIO_SECONDS,
    })
    expect(clampLimits({ maxUploadBytes: -1, maxAudioSeconds: 0 })).toEqual({
      maxUploadBytes: ABSOLUTE_MAX_UPLOAD_BYTES,
      maxAudioSeconds: ABSOLUTE_MAX_AUDIO_SECONDS,
    })
  })

  it('admits no language when the service reports transcription as unsupported', () => {
    const view = projectCapabilities(snapshot({
      status: 'unsupported',
      reason: 'disabled',
      languages: { status: 'supported', values: ['zh', 'en'] },
    }))
    expect(view?.transcriptionSupported).toBe(false)
    // An endpoint that cannot transcribe states nothing usable about languages, however many it
    // listed: admitting them would widen the selector for an operation that is refused outright.
    expect(view?.languages).toEqual({ status: 'unknown', values: [] })
    // Which is the claim the name makes, so it is asserted rather than assumed.
    expect(languageOptionsFor(view)).toEqual(['auto'])
    expect(languageIsAdmitted('zh', view)).toBe(false)
  })

  it('keeps an unstated limit at the value already in force', () => {
    const inForce = { maxUploadBytes: 1_048_576, maxAudioSeconds: 30 }
    // An unstated limit inherits; a stated one is taken (bounded by the ceilings).
    expect(clampLimits({ maxUploadBytes: null, maxAudioSeconds: null }, inForce)).toEqual(inForce)
    expect(clampLimits({ maxUploadBytes: 524_288, maxAudioSeconds: null }, inForce)).toEqual({
      maxUploadBytes: 524_288,
      maxAudioSeconds: 30,
    })
    expect(clampLimits({ maxUploadBytes: null, maxAudioSeconds: 120 }, inForce)).toEqual({
      maxUploadBytes: 1_048_576,
      maxAudioSeconds: 120,
    })
    expect(clampLimits({ maxUploadBytes: 8_388_608, maxAudioSeconds: null }, inForce)).toEqual({
      maxUploadBytes: ABSOLUTE_MAX_UPLOAD_BYTES,
      maxAudioSeconds: 30,
    })
  })
})
