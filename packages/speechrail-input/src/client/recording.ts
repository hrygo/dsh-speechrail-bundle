/**
 * Browser-owned microphone capture and native Web Audio resampling.
 *
 * The capture lifecycle follows the behaviour of the frozen official baseline
 * (`upstream/.../client-ui-voice-input/src/client/audio.ts`, MIT): a permission
 * grant that settles after cancellation releases its tracks immediately, device
 * interruption tears the recording down before the caller is notified, and the
 * recorded blob is decoded and resampled to 16 kHz mono by an OfflineAudioContext.
 * @module @hrygo/dsh-speechrail-bundle/client/recording
 */

import { encodeWave } from '../protocol/wave.ts'

/** Capture failure whose localized text is chosen by the caller. */
export class RecordingError extends Error {
  constructor(readonly kind: 'unavailable' | 'permission' | 'empty' | 'cancelled' | 'interrupted' | 'deviceMissing' | 'tooLarge') {
    super(kind)
    this.name = 'RecordingError'
  }
}

/**
 * Encode a recording for the JSON Remote carrier.
 * @param bytes - complete WAV bytes.
 * @returns base64 with no data-URL prefix.
 */
export function audioBase64(bytes: Uint8Array): string {
  let text = ''
  for (let index = 0; index < bytes.length; index += 8192) text += String.fromCharCode(...bytes.subarray(index, index + 8192))
  return btoa(text)
}

/** One microphone acquisition, including a permission prompt that may settle after cancellation. */
export class Recording {
  private stream: MediaStream | undefined
  private recorder: MediaRecorder | undefined
  private context: AudioContext | undefined
  private analyser: AnalyserNode | undefined
  private readonly samples = new Float32Array(256)
  private chunks: Blob[] = []
  private readonly lifetime = new AbortController()
  private disposal: Promise<void> | undefined

  constructor(private readonly onDispose: () => void, private readonly deviceId = '') {}

  /**
   * Acquire the selected microphone without recording or playing audio.
   * @param onError - receives device interruptions before resource release completes.
   * @returns after the level analyser starts.
   */
  async preview(onError?: (error: RecordingError) => void): Promise<void> {
    const devices = (navigator as Partial<Navigator>).mediaDevices
    if (!devices) throw new RecordingError('unavailable')
    let stream: MediaStream
    try {
      stream = await devices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          ...(this.deviceId === '' ? {} : { deviceId: { exact: this.deviceId } }),
        },
        video: false,
      })
    } catch (error) {
      if (error instanceof DOMException) {
        if (error.name === 'NotAllowedError') throw new RecordingError('permission')
        if (error.name === 'NotFoundError' || error.name === 'OverconstrainedError') throw new RecordingError('deviceMissing')
      }
      throw error
    }
    if (this.lifetime.signal.aborted) {
      for (const track of stream.getTracks()) track.stop()
      throw new RecordingError('cancelled')
    }
    this.stream = stream
    try {
      this.context = new AudioContext()
      this.analyser = this.context.createAnalyser()
      this.analyser.fftSize = this.samples.length
      this.context.createMediaStreamSource(stream).connect(this.analyser)
      for (const track of stream.getTracks()) {
        track.addEventListener('ended', () => { this.interrupted(onError) }, { signal: this.lifetime.signal })
      }
    } catch (error) {
      await this.dispose()
      throw error
    }
  }

  /**
   * Acquire the selected microphone and start recording.
   * @param onError - receives failures that happen while capture is live.
   * @returns after capture starts.
   */
  async start(onError?: (error: RecordingError) => void): Promise<void> {
    if (typeof MediaRecorder === 'undefined') throw new RecordingError('unavailable')
    await this.preview(onError)
    if (this.lifetime.signal.aborted) throw new RecordingError('cancelled')
    try {
      this.recorder = new MediaRecorder(this.stream as MediaStream)
      this.recorder.ondataavailable = (event) => {
        if (!this.lifetime.signal.aborted && event.data.size > 0) this.chunks.push(event.data)
      }
      this.recorder.onerror = () => { this.interrupted(onError) }
      this.recorder.start()
    } catch (error) {
      await this.dispose()
      throw error
    }
  }

  /**
   * Read the live microphone signal.
   * @returns the measured RMS level, or zero outside capture.
   */
  amplitude(): number {
    if (!this.analyser) return 0
    this.analyser.getFloatTimeDomainData(this.samples)
    let sum = 0
    for (const sample of this.samples) sum += sample * sample
    return Math.sqrt(sum / this.samples.length)
  }

  /**
   * Finish capture and resample the recording to canonical 16 kHz mono WAV.
   * @param maxDurationSeconds - truncate timer overshoot to the admitted limit.
   * @param maxBytes - admitted upload ceiling, checked before the caller uploads.
   * @returns one WAV recording after the final MediaRecorder chunk arrives.
   */
  async stop(maxDurationSeconds: number, maxBytes: number): Promise<Uint8Array> {
    const recorder = this.recorder
    const context = this.context
    if (!recorder || !context || recorder.state !== 'recording') {
      await this.dispose()
      throw new RecordingError('empty')
    }
    try {
      await new Promise<void>((resolve, reject) => {
        recorder.onstop = () => { resolve() }
        recorder.onerror = () => { reject(new RecordingError('empty')) }
        recorder.stop()
      })
      for (const track of this.stream?.getTracks() ?? []) track.stop()
      this.lifetime.signal.throwIfAborted()
      const blob = new Blob(this.chunks, { type: recorder.mimeType })
      if (blob.size === 0) throw new RecordingError('empty')
      const decoded = await context.decodeAudioData(await blob.arrayBuffer())
      this.lifetime.signal.throwIfAborted()
      const frames = Math.max(1, Math.floor(Math.min(decoded.duration, maxDurationSeconds) * 16000))
      const offline = new OfflineAudioContext(1, frames, 16000)
      const source = offline.createBufferSource()
      source.buffer = decoded
      source.connect(offline.destination)
      source.start()
      const resampled = await offline.startRendering()
      this.lifetime.signal.throwIfAborted()
      const wave = encodeWave(resampled.getChannelData(0))
      if (wave.byteLength > maxBytes) throw new RecordingError('tooLarge')
      return wave
    } finally {
      await this.dispose()
    }
  }

  /**
   * Release this recording and invalidate pending permission grants.
   * @returns the shared release promise, including any AudioContext close failure.
   */
  dispose(): Promise<void> {
    if (!this.disposal) {
      const closing = Promise.withResolvers<void>()
      this.disposal = closing.promise
      void this.release().then(closing.resolve, closing.reject)
    }
    return this.disposal
  }

  /** Tear resources down once and report interruption. */
  private interrupted(onError: ((error: RecordingError) => void) | undefined): void {
    if (this.lifetime.signal.aborted) return
    void this.dispose().catch(() => undefined)
    try {
      onError?.(new RecordingError('interrupted'))
    } catch (error) {
      console.error('SpeechRail recording error handler failed', error)
    }
  }

  /** Release tracks, recorder and audio context exactly once. */
  private async release(): Promise<void> {
    this.lifetime.abort(new RecordingError('cancelled'))
    if (this.recorder?.state === 'recording') this.recorder.stop()
    for (const track of this.stream?.getTracks() ?? []) track.stop()
    this.stream = undefined
    const context = this.context
    this.context = undefined
    this.analyser = undefined
    this.chunks = []
    try {
      if (context && context.state !== 'closed') await context.close()
    } finally {
      this.onDispose()
    }
  }
}
