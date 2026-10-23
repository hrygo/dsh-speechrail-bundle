import { describe, expect, it } from 'vitest'
import { encodeWave, validateWave, waveSeconds } from '../src/protocol/wave.ts'

/** Build canonical bytes for the given sample count. */
function wave(samples: number): Uint8Array {
  return encodeWave(new Float32Array(samples))
}

describe('validateWave', () => {
  it('accepts the bytes this package encodes and reports their duration', () => {
    const bytes = wave(16_000)
    expect(validateWave(bytes, 120)).toEqual({ ok: true, seconds: 1, byteLength: 32_044 })
    expect(waveSeconds(bytes)).toBe(1)
    expect(validateWave(wave(8_000), 120)).toEqual({ ok: true, seconds: 0.5, byteLength: 16_044 })
  })

  it('round-trips sample values through PCM16', () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1])
    const result = validateWave(encodeWave(samples), 120)
    expect(result.ok).toBe(true)
    const view = new DataView(encodeWave(samples).buffer)
    expect(view.getInt16(44, true)).toBe(0)
    expect(view.getInt16(46, true)).toBe(16_384)
    expect(view.getInt16(48, true)).toBe(-16_384)
    expect(view.getInt16(50, true)).toBe(32_767)
    expect(view.getInt16(52, true)).toBe(-32_768)
  })

  it('refuses a truncated recording', () => {
    expect(validateWave(new Uint8Array(10), 120)).toEqual({ ok: false, reason: 'too-short' })
    expect(validateWave(new Uint8Array(45), 120)).toEqual({ ok: false, reason: 'too-short' })
  })

  it('refuses wrong container tags', () => {
    const bytes = wave(100)
    bytes[0] = 0x52
    bytes[1] = 0x49
    bytes[2] = 0x46
    bytes[3] = 0x58
    expect(validateWave(bytes, 120)).toEqual({ ok: false, reason: 'not-riff' })
  })

  it('refuses non-canonical formats', () => {
    const wrongRate = wave(100)
    new DataView(wrongRate.buffer).setUint32(24, 44_100, true)
    expect(validateWave(wrongRate, 120)).toEqual({ ok: false, reason: 'not-pcm16-mono-16k' })

    const stereo = wave(100)
    new DataView(stereo.buffer).setUint16(22, 2, true)
    expect(validateWave(stereo, 120)).toEqual({ ok: false, reason: 'not-pcm16-mono-16k' })

    const eightBit = wave(100)
    new DataView(eightBit.buffer).setUint16(34, 8, true)
    expect(validateWave(eightBit, 120)).toEqual({ ok: false, reason: 'not-pcm16-mono-16k' })
  })

  it('refuses inconsistent lengths instead of trusting a plausible header', () => {
    const riffLength = wave(100)
    new DataView(riffLength.buffer).setUint32(4, 1_000, true)
    expect(validateWave(riffLength, 120)).toEqual({ ok: false, reason: 'length-mismatch' })

    const dataLength = wave(100)
    new DataView(dataLength.buffer).setUint32(40, 4, true)
    expect(validateWave(dataLength, 120)).toEqual({ ok: false, reason: 'length-mismatch' })

    const odd = new Uint8Array(245)
    odd.set(wave(100))
    expect(validateWave(odd, 120)).toEqual({ ok: false, reason: 'length-mismatch' })

    const dataTag = wave(100)
    dataTag[36] = 0x78
    expect(validateWave(dataTag, 120)).toEqual({ ok: false, reason: 'length-mismatch' })
  })

  it('refuses a recording longer than the admitted duration', () => {
    expect(validateWave(wave(1_601), 0.1)).toEqual({ ok: false, reason: 'too-long' })
    expect(validateWave(wave(1_600), 0.1).ok).toBe(true)
  })
})
