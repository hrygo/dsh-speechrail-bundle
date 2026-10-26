/**
 * Strict canonical-WAV validation shared by the Host and the browser client.
 *
 * The same rules run before upload and before inference, so an encoder regression
 * fails locally instead of consuming a remote model slot.
 * @module dsh-voice-input/protocol/wave
 */

/** Why a recording was refused. */
export type WaveRefusal =
  | 'too-short'
  | 'not-riff'
  | 'not-pcm16-mono-16k'
  | 'length-mismatch'
  | 'too-long'

/** Accepted canonical recording. */
export interface WaveAccepted {
  /** Whether the bytes are a canonical recording. */
  readonly ok: true
  /** Recording duration in seconds derived from the data chunk. */
  readonly seconds: number
  /** Total byte length. */
  readonly byteLength: number
}

/** Refused recording. */
export interface WaveRejected {
  /** Whether the bytes are a canonical recording. */
  readonly ok: false
  /** Stable machine-readable refusal reason. */
  readonly reason: WaveRefusal
}

/** Result of validating one recording. */
export type WaveResult = WaveAccepted | WaveRejected

/** Canonical header length: RIFF/WAVE, a 16-byte PCM fmt chunk and the data chunk header. */
const HEADER_BYTES = 44

/** Bytes per second of 16 kHz mono PCM16 audio. */
const BYTES_PER_SECOND = 32_000

/** Read four ASCII bytes as text; returns a sentinel when the range is out of bounds. */
function tag(view: DataView, offset: number): string {
  if (offset + 4 > view.byteLength) return ''
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  )
}

/**
 * Validate that a recording is exactly the canonical 16 kHz mono PCM16 WAV this
 * service accepts, rejecting any header or length inconsistency.
 * @param audio - candidate bytes.
 * @param maxDurationSeconds - maximum admitted duration.
 * @returns the duration and length, or the reason the bytes were refused.
 */
export function validateWave(audio: Uint8Array, maxDurationSeconds: number): WaveResult {
  if (audio.byteLength < HEADER_BYTES + 2) return { ok: false, reason: 'too-short' }
  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength)
  const header = tag(view, 0) === 'RIFF' && tag(view, 8) === 'WAVE' && tag(view, 12) === 'fmt '
  const format = view.getUint32(16, true) === 16
    && view.getUint16(20, true) === 1
    && view.getUint16(22, true) === 1
    && view.getUint32(24, true) === 16_000
    && view.getUint32(28, true) === 32_000
    && view.getUint16(32, true) === 2
    && view.getUint16(34, true) === 16
  if (!header) return { ok: false, reason: 'not-riff' }
  if (!format) return { ok: false, reason: 'not-pcm16-mono-16k' }
  const dataBytes = audio.byteLength - HEADER_BYTES
  const consistent = tag(view, 36) === 'data'
    && view.getUint32(4, true) === audio.byteLength - 8
    && view.getUint32(40, true) === dataBytes
    && dataBytes % 2 === 0
  if (!consistent) return { ok: false, reason: 'length-mismatch' }
  const seconds = dataBytes / BYTES_PER_SECOND
  if (seconds > maxDurationSeconds) return { ok: false, reason: 'too-long' }
  return { ok: true, seconds, byteLength: audio.byteLength }
}

/**
 * Encode mono floating-point samples as the canonical PCM16 WAV this service accepts.
 * @param samples - 16 kHz mono samples in the range -1..1.
 * @returns complete little-endian WAV bytes.
 */
export function encodeWave(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(HEADER_BYTES + samples.length * 2)
  const view = new DataView(bytes.buffer)
  const text = (at: number, value: string): void => {
    for (let index = 0; index < value.length; index += 1) bytes[at + index] = value.charCodeAt(index)
  }
  text(0, 'RIFF')
  view.setUint32(4, bytes.byteLength - 8, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 16_000, true)
  view.setUint32(28, 32_000, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0))
    view.setInt16(HEADER_BYTES + index * 2, Math.round(sample * (sample < 0 ? 32_768 : 32_767)), true)
  }
  return bytes
}

/**
 * Read the recording duration of already-validated canonical bytes.
 * @param audio - canonical WAV bytes.
 * @returns duration in seconds.
 */
export function waveSeconds(audio: Uint8Array): number {
  return (audio.byteLength - HEADER_BYTES) / BYTES_PER_SECOND
}
