import { describe, expect, it } from 'vitest'
import {
  CONFIG_PAYLOAD_MAX_BYTES,
  TRANSCRIBE_PAYLOAD_MAX_BYTES,
  type SpeechRailFailure,
} from '../src/contracts.ts'
import { SpeechRailInputCore, type CoreDependencies, type ResolvedConfig } from '../src/host/core.ts'
import { journalFromUnit, memoryJournal, type JournalRecord, type JournalState, type PendingJournal } from '../src/host/journal.ts'
import type { ProbeOutcome, TranscribeOutcome } from '../src/host/http.ts'
import { encodeWave } from '../src/protocol/wave.ts'

/** Canonical base64 audio for the given sample count. */
function audio(samples: number): string {
  return Buffer.from(encodeWave(new Float32Array(samples))).toString('base64')
}

const CONFIG: ResolvedConfig = {
  rawBaseUrl: 'http://127.0.0.1:8201/v1',
  baseUrl: 'http://127.0.0.1:8201/v1',
  endpointRefusal: null,
  model: '',
  credentialRef: 'SPEECHRAIL_API_KEY',
  language: 'auto',
  requestTimeoutMs: 150_000,
}

interface Send {
  readonly baseUrl: string
  readonly language: string | null
  readonly credential: string
  readonly audio: Uint8Array
  readonly pendingAtSend: JournalRecord | null
  readonly alreadyRecorded: boolean
  readonly timedOut: boolean
}

interface Harness {
  core: SpeechRailInputCore
  readonly sends: Send[]
  journal: PendingJournal
  fail: SpeechRailFailure | null
  probe: ProbeOutcome
  clearFails: boolean
  recordFails: boolean
  readFails: boolean
  config: ResolvedConfig
  credential: string | null
  revision: number
  writes: { language: string; requestTimeoutMs: number; expectedRevision: number }[]
  writeResult: 'ok' | 'conflict' | 'failed'
}

/** Build the engine over controllable doubles, defaulting to a healthy local service. */
function harness(options: { readonly pending?: JournalRecord | null } = {}): Harness {
  let stored: JournalRecord | null = options.pending ?? null
  const state: Harness = {
    core: undefined as unknown as SpeechRailInputCore,
    sends: [],
    journal: undefined as unknown as PendingJournal,
    fail: null,
    probe: { ok: true, capabilities: null },
    clearFails: false,
    recordFails: false,
    readFails: false,
    config: CONFIG,
    credential: 'secret-key',
    revision: 3,
    writes: [],
    writeResult: 'ok',
  }
  const journal: PendingJournal = {
    async read(): Promise<JournalState> {
      if (state.readFails) return { available: false }
      return { available: true, pending: stored }
    },
    async record(entry): Promise<boolean> {
      if (state.recordFails) return false
      stored = entry
      return true
    },
    async clear(operationId): Promise<boolean> {
      if (state.clearFails) return false
      if (stored !== null && stored.operationId !== operationId) return false
      stored = null
      return true
    },
  }
  state.journal = journal
  const deps: CoreDependencies = {
    now: () => new Date('2026-10-23T12:00:00.000Z'),
    config: () => state.config,
    resolveCredential: async () => state.credential,
    journal,
    transcribe: async (request): Promise<TranscribeOutcome> => {
      const pendingAtSend = stored
      state.sends.push({
        baseUrl: request.baseUrl,
        language: request.language,
        credential: request.credential,
        audio: request.audio,
        pendingAtSend,
        alreadyRecorded: pendingAtSend !== null && pendingAtSend.phase === 'pending',
        timedOut: request.timeoutMs > 0 && state.fail === null && false,
      })
      if (state.fail !== null) return { ok: false, failure: state.fail }
      return { ok: true, text: 'hello world', requestSeconds: 1.25 }
    },
    probe: async () => state.probe,
    settingsRevision: () => state.revision,
    writeSettings: async (patch, expectedRevision) => {
      state.writes.push({ ...patch, expectedRevision })
      return state.writeResult
    },
  }
  state.core = new SpeechRailInputCore(deps)
  return state
}

/** Valid transcription payload text. */
function payload(operationId: string, samples = 16_000): string {
  return JSON.stringify({ operationId, audioBase64: audio(samples) })
}

describe('payload strictness', () => {
  it('refuses unknown keys instead of silently dropping them', async () => {
    const h = harness()
    const text = JSON.stringify({ operationId: 'op_12345678', audioBase64: audio(100), audioSeconds: 1 })
    const result = await h.core.transcribe(text)
    expect(result.ok).toBe(false)
    expect(result.failure?.code).toBe('bad-request')
    expect(h.sends).toHaveLength(0)
  })

  it('refuses a payload larger than the carrier bound', async () => {
    const h = harness()
    const oversized = `{"operationId":"op_12345678","audioBase64":"${'A'.repeat(TRANSCRIBE_PAYLOAD_MAX_BYTES)}"}`
    expect((await h.core.transcribe(oversized)).failure?.code).toBe('bad-request')
  })

  it('refuses malformed operation ids, non-base64 audio and non-JSON carriers', async () => {
    const h = harness()
    expect((await h.core.transcribe(JSON.stringify({ operationId: 'short', audioBase64: audio(10) }))).failure?.code).toBe('bad-request')
    expect((await h.core.transcribe(JSON.stringify({ operationId: 'op_12345678', audioBase64: 'not base64!' }))).failure?.code).toBe('bad-request')
    expect((await h.core.transcribe('{')).failure?.code).toBe('bad-request')
    expect((await h.core.transcribe(JSON.stringify({ operationId: 'op_12345678' }))).failure?.code).toBe('bad-request')
    expect(h.sends).toHaveLength(0)
  })

  it('refuses a configuration payload with unknown keys or out-of-range values', async () => {
    const h = harness()
    expect((await h.core.configure(JSON.stringify({ language: 'auto', requestTimeoutMs: 5_000, expectedRevision: 3, extra: 1 }))).failure?.code).toBe('bad-request')
    expect((await h.core.configure(JSON.stringify({ language: 'ja', requestTimeoutMs: 5_000, expectedRevision: 3 }))).failure?.code).toBe('bad-request')
    expect((await h.core.configure(JSON.stringify({ language: 'auto', requestTimeoutMs: 1.5, expectedRevision: 3 }))).failure?.code).toBe('bad-request')
    expect((await h.core.configure('x'.repeat(CONFIG_PAYLOAD_MAX_BYTES + 1))).failure?.code).toBe('bad-request')
    expect(h.writes).toHaveLength(0)
  })
})

describe('single in-flight gate', () => {
  it('claims the gate synchronously so a concurrent upload is refused without a second request', async () => {
    const h = harness()
    const first = h.core.transcribe(payload('op_aaaaaaaa'))
    const second = await h.core.transcribe(payload('op_bbbbbbbb'))
    expect(second.failure?.code).toBe('busy')
    expect(second.failure?.retryable).toBe(true)
    expect((await first).ok).toBe(true)
    expect(h.sends).toHaveLength(1)
    expect((await h.core.status()).gate).toBe('ready')
  })

  it('records the operation durably before the first request byte', async () => {
    const h = harness()
    const result = await h.core.transcribe(payload('op_cccccccc'))
    expect(result.ok).toBe(true)
    expect(h.sends[0]?.alreadyRecorded).toBe(true)
    expect(h.sends[0]?.pendingAtSend?.operationId).toBe('op_cccccccc')
  })

  it('sends nothing and keeps no record when the journal is unusable', async () => {
    const h = harness()
    h.readFails = true
    const result = await h.core.transcribe(payload('op_dddddddd'))
    expect(result.failure?.code).toBe('journal-unavailable')
    expect(h.sends).toHaveLength(0)
    expect((await h.core.status()).gate).toBe('ready')
  })

  it('sends nothing when the pending record cannot be written', async () => {
    const h = harness()
    h.recordFails = true
    const result = await h.core.transcribe(payload('op_eeeeeeee'))
    expect(result.failure?.code).toBe('journal-unavailable')
    expect(h.sends).toHaveLength(0)
  })

  it('sends nothing when the credential is absent', async () => {
    const h = harness()
    h.credential = null
    const result = await h.core.transcribe(payload('op_ffffffff'))
    expect(result.failure?.code).toBe('not-configured')
    expect(h.sends).toHaveLength(0)
    expect((await h.core.status()).gate).toBe('ready')
  })

  it('refuses non-canonical audio before recording anything', async () => {
    const h = harness()
    const result = await h.core.transcribe(JSON.stringify({ operationId: 'op_gggggggg', audioBase64: Buffer.from(new Uint8Array(500)).toString('base64') }))
    expect(result.failure?.code).toBe('audio-invalid')
    expect(h.sends).toHaveLength(0)
  })
})

describe('successful transcription', () => {
  it('reports WAV-derived duration, wall-clock request time and an unknown inference time', async () => {
    const h = harness()
    const result = await h.core.transcribe(payload('op_hhhhhhhh', 8_000))
    expect(result.ok).toBe(true)
    expect(result.transcript).toEqual({
      operationId: 'op_hhhhhhhh',
      text: 'hello world',
      audioSeconds: 0.5,
      requestSeconds: 1.25,
      inferenceSeconds: null,
    })
  })

  it('omits the language field for automatic mode and sends the hint only when admitted', async () => {
    const h = harness()
    await h.core.transcribe(payload('op_iiiiiiii'))
    expect(h.sends[0]?.language).toBeNull()

    h.config = { ...CONFIG, language: 'zh' }
    h.probe = {
      ok: true,
      capabilities: {
        schemaVersion: 'effective_capabilities_v1',
        transcriptionSupported: true,
        reason: null,
        languages: { status: 'supported', values: ['zh'] },
        limits: { maxUploadBytes: 4 * 1024 * 1024, maxAudioSeconds: 120 },
      },
    }
    await h.core.check()
    await h.core.transcribe(payload('op_jjjjjjjj'))
    expect(h.sends[1]?.language).toBe('zh')
  })

  it('falls back to automatic mode when the snapshot does not admit the configured language', async () => {
    const h = harness()
    h.config = { ...CONFIG, language: 'zh' }
    await h.core.transcribe(payload('op_kkkkkkkk'))
    expect(h.sends[0]?.language).toBeNull()
  })
})

describe('unproven outcomes', () => {
  it('closes the gate, blocks the next attempt and requires the matching acknowledgement', async () => {
    const h = harness()
    h.fail = { code: 'timeout', httpStatus: null, retryable: true, requestId: null, outcome: 'unknown' }
    const result = await h.core.transcribe(payload('op_llllllll'))
    expect(result.ok).toBe(false)
    expect(result.failure?.outcome).toBe('unknown')
    expect((await h.core.status()).gate).toBe('unknown')
    expect((await h.core.status()).pendingOperationId).toBe('op_llllllll')

    const blocked = await h.core.transcribe(payload('op_mmmmmmmm'))
    expect(blocked.failure?.code).toBe('unknown-outcome')
    expect(h.sends).toHaveLength(1)

    const wrong = await h.core.acknowledgeUnknown(JSON.stringify({ operationId: 'op_zzzzzzzz' }))
    expect(wrong.ok).toBe(false)
    expect(wrong.failure?.code).toBe('conflict')
    expect((await h.core.status()).gate).toBe('unknown')

    const right = await h.core.acknowledgeUnknown(JSON.stringify({ operationId: 'op_llllllll' }))
    expect(right).toEqual({ ok: true, pendingOperationId: null, failure: null })
    expect((await h.core.status()).gate).toBe('ready')
    h.fail = null
    expect((await h.core.transcribe(payload('op_nnnnnnnn'))).ok).toBe(true)
  })

  it('keeps the gate closed when the acknowledgement cannot be persisted', async () => {
    const h = harness()
    h.fail = { code: 'cancelled', httpStatus: null, retryable: false, requestId: null, outcome: 'unknown' }
    await h.core.transcribe(payload('op_oooooooo'))
    h.clearFails = true
    const result = await h.core.acknowledgeUnknown(JSON.stringify({ operationId: 'op_oooooooo' }))
    expect(result.ok).toBe(false)
    expect(result.failure?.code).toBe('journal-unavailable')
    expect((await h.core.status()).gate).toBe('unknown')
  })

  it('restores an unproven operation after a reload and never lets a check clear it', async () => {
    const h = harness({ pending: { operationId: 'op_pppppppp', phase: 'pending', createdAt: '2026-10-23T11:00:00.000Z' } })
    await h.core.restore()
    expect((await h.core.status()).gate).toBe('unknown')

    const checked = await h.core.check()
    expect(checked.reachable).toBe(true)
    expect((await h.core.status()).gate).toBe('unknown')

    const blocked = await h.core.transcribe(payload('op_qqqqqqqq'))
    expect(blocked.failure?.code).toBe('unknown-outcome')
    expect(h.sends).toHaveLength(0)
  })

  it('treats an unreadable journal as closed rather than as empty', async () => {
    const h = harness()
    h.readFails = true
    await h.core.restore()
    expect((await h.core.status()).gate).toBe('unknown')
    expect((await h.core.status()).pendingOperationId).toBeNull()
  })
})

describe('configuration writes', () => {
  it('refuses a stale revision and accepts the current one', async () => {
    const h = harness()
    const stale = await h.core.configure(JSON.stringify({ language: 'en', requestTimeoutMs: 60_000, expectedRevision: 2 }))
    expect(stale.ok).toBe(false)
    expect(stale.failure?.code).toBe('conflict')
    expect(stale.revision).toBe(3)
    expect(h.writes).toHaveLength(0)

    h.revision = 3
    const fresh = await h.core.configure(JSON.stringify({ language: 'en', requestTimeoutMs: 60_000, expectedRevision: 3 }))
    expect(fresh.ok).toBe(true)
    expect(h.writes).toEqual([{ language: 'en', requestTimeoutMs: 60_000, expectedRevision: 3 }])
  })

  it('reports a storage-level conflict instead of claiming success', async () => {
    const h = harness()
    h.writeResult = 'conflict'
    const result = await h.core.configure(JSON.stringify({ language: 'auto', requestTimeoutMs: 60_000, expectedRevision: 3 }))
    expect(result.ok).toBe(false)
    expect(result.failure?.code).toBe('conflict')
  })
})

describe('journal medium', () => {
  it('round-trips a record through a storage unit and clears by id', async () => {
    let stored: unknown = null
    const journal = journalFromUnit({
      readGlobal: async () => stored,
      writeGlobal: async (value) => { stored = value },
    })
    expect(await journal.read()).toEqual({ available: true, pending: null })
    expect(await journal.record({ operationId: 'op_rrrrrrrr', phase: 'pending', createdAt: '2026-10-23T12:00:00.000Z' })).toBe(true)
    expect(await journal.read()).toEqual({
      available: true,
      pending: { operationId: 'op_rrrrrrrr', phase: 'pending', createdAt: '2026-10-23T12:00:00.000Z' },
    })
    expect(await journal.clear('op_ssssssss')).toBe(false)
    expect(await journal.clear('op_rrrrrrrr')).toBe(true)
    expect(await journal.read()).toEqual({ available: true, pending: null })
  })

  it('reports a corrupt record as unusable instead of as empty', async () => {
    const journal = journalFromUnit({
      readGlobal: async () => ({ operationId: '../../etc/passwd', phase: 'pending', createdAt: 'nope' }),
      writeGlobal: async () => undefined,
    })
    expect(await journal.read()).toEqual({ available: false })
  })

  it('reports a failing medium as unusable and refuses to write', async () => {
    const journal = journalFromUnit({
      readGlobal: async () => { throw new Error('malformed-medium') },
      writeGlobal: async () => { throw new Error('readonly') },
    })
    expect(await journal.read()).toEqual({ available: false })
    expect(await journal.record({ operationId: 'op_tttttttt', phase: 'pending', createdAt: '2026-10-23T12:00:00.000Z' })).toBe(false)
    expect(await journal.clear('op_tttttttt')).toBe(false)
  })

  it('provides an in-memory journal for tests and minimal compositions', async () => {
    const journal = memoryJournal()
    expect(await journal.read()).toEqual({ available: true, pending: null })
    expect(await journal.record({ operationId: 'op_uuuuuuuu', phase: 'pending', createdAt: '2026-10-23T12:00:00.000Z' })).toBe(true)
    expect(await journal.clear('op_vvvvvvvv')).toBe(false)
  })
})
