import { describe, expect, it } from 'vitest'
import {
  CONFIG_PAYLOAD_MAX_BYTES,
  TRANSCRIBE_PAYLOAD_MAX_BYTES,
  type SpeechRailFailure,
} from '../src/contracts.ts'
import { SpeechRailInputCore, type CoreDependencies, type ResolvedConfig } from '../src/host/core.ts'
import { failure, unknownFailure } from '../src/host/failure.ts'
import { JOURNAL_UNIT, JOURNAL_VERSION, journalFromUnit, memoryJournal, type JournalRecord, type JournalState, type PendingJournal } from '../src/host/journal.ts'
import type { ProbeOutcome, TranscribeOutcome } from '../src/host/http.ts'
import { encodeWave } from '../src/protocol/wave.ts'

/** Canonical base64 audio for the given sample count. */
function audio(samples: number): string {
  return Buffer.from(encodeWave(new Float32Array(samples))).toString('base64')
}

const CONFIG: ResolvedConfig = {
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
  probeCalls: number
  clearFails: boolean
  recordFails: boolean
  readFails: boolean
  /** When set, `read()` queues its resolution for the test to release. */
  deferReads: boolean
  pendingReads: Array<(state: JournalState) => void>
  /** When set, the transcribe seam waits for it, holding an upload in flight. */
  transcribeHold: Promise<void> | null
  /** When set, the erase waits for a resolver, holding it in flight. */
  deferReset: boolean
  pendingResets: Array<(ok: boolean) => void>
  /** When set, the id-matched clear waits for a resolver, holding it in flight. */
  deferClear: boolean
  pendingClears: Array<(ok: boolean) => void>
  /** Readable medium holding a malformed record: unreadable, but writable. */
  corrupt: boolean
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
    probeCalls: 0,
    clearFails: false,
    recordFails: false,
    readFails: false,
    deferReads: false,
    pendingReads: [],
    transcribeHold: null,
    deferReset: false,
    pendingResets: [],
    deferClear: false,
    pendingClears: [],
    corrupt: false,
    config: CONFIG,
    credential: 'secret-key',
    revision: 3,
    writes: [],
    writeResult: 'ok',
  }
  const journal: PendingJournal = {
    async read(): Promise<JournalState> {
      if (state.deferReads) return await new Promise<JournalState>((resolve) => { state.pendingReads.push(resolve) })
      if (state.readFails || state.corrupt) return { available: false }
      return { available: true, pending: stored }
    },
    async record(entry): Promise<boolean> {
      if (state.readFails || state.recordFails) return false
      stored = entry
      state.corrupt = false
      return true
    },
    async clear(operationId): Promise<boolean> {
      if (state.deferClear) return await new Promise<boolean>((resolve) => { state.pendingClears.push(resolve) })
      // Faithful to journalFromUnit: a medium whose read throws cannot compare ids,
      // so it cannot clear either. A double where read fails but clear succeeds
      // models a state no real medium can be in.
      if (state.readFails || state.corrupt || state.clearFails) return false
      if (stored !== null && stored.operationId !== operationId) return false
      stored = null
      return true
    },
    async reset(): Promise<boolean> {
      // Faithful to journalFromUnit.reset(): it reads first, so an unopenable medium and a
      // slot holding a readable record both refuse, while unreadable bytes are overwritten.
      if (state.deferReset) return await new Promise<boolean>((resolve) => { state.pendingResets.push(resolve) })
      if (state.readFails || state.recordFails) return false
      if (stored !== null) return false
      // Overwriting the slot replaces whatever unreadable bytes were there, which is
      // what makes the reset an actual recovery rather than a one-time unblock.
      stored = null
      state.corrupt = false
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
      if (state.transcribeHold !== null) await state.transcribeHold
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
    probe: async () => {
      state.probeCalls += 1
      return state.probe
    },
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

describe('unreadable medium recovery', () => {
  it('re-reads the journal once it is readable instead of refusing forever', async () => {
    // A medium that cannot be opened at boot used to disable every upload until the user
    // acknowledged a record that never existed, even after storage came back.
    const h = harness()
    h.readFails = true
    await h.core.restore()
    h.readFails = false

    const result = await h.core.transcribe(payload('op_wwwwwwww'))
    expect(result.ok).toBe(true)
    expect(h.sends).toHaveLength(1)
  })

  it('adopts a record that was written while the medium was unreadable', async () => {
    // Seeded before boot, invisible while the medium is unreadable, then adopted on recovery.
    const h = harness({ pending: { operationId: 'op_rrrrrrrr', phase: 'unknown', createdAt: '2026-10-23T11:00:00.000Z' } })
    h.readFails = true
    await h.core.restore()
    h.readFails = false

    const result = await h.core.transcribe(payload('op_ssssssss'))
    expect(result.failure?.code).toBe('unknown-outcome')
    expect(h.sends).toHaveLength(0)
    expect((await h.core.status()).pendingOperationId).toBe('op_rrrrrrrr')
  })

  it('ignores a recovery read that resolves after the gate was already cleared', async () => {
    // Two attempts start while the medium looks unreadable, so both issue a recovery read.
    // The first adopts the record; the user then acknowledges it; the second resolves with
    // the snapshot it took before that clear. Applying it would resurrect a gate that
    // nothing holds and refuse the next upload.
    const record = { operationId: 'op_rrrrrrrr', phase: 'unknown' as const, createdAt: '2026-10-23T11:00:00.000Z' }
    const h = harness({ pending: record })
    h.readFails = true
    await h.core.restore()
    h.readFails = false
    h.deferReads = true

    const first = h.core.transcribe(payload('op_tttttttt'))
    const second = h.core.transcribe(payload('op_uuuuuuuu'))
    await Promise.resolve()
    await Promise.resolve()
    expect(h.pendingReads).toHaveLength(2)

    h.pendingReads.shift()?.({ available: true, pending: record })
    await first
    const cleared = await h.core.acknowledgeUnknown(JSON.stringify({ operationId: 'op_rrrrrrrr' }))
    expect(cleared.ok).toBe(true)

    h.pendingReads.shift()?.({ available: true, pending: record })
    // Later reads in the same attempt are ordinary again.
    h.deferReads = false
    const result = await second
    expect(result.ok).toBe(true)
    expect(h.sends).toHaveLength(1)
    expect((await h.core.status()).pendingOperationId).toBe(null)
  })

  it('ignores a recovery read older than the record now held', async () => {
    // The gate stays "unknown" while a newer record is adopted by a second attempt, so a
    // gate-only guard would let an older read overwrite that id. Clearing compares ids, so
    // the status and the journal would then disagree and acknowledgement would dead-end.
    const stale = { operationId: 'op_old0000001', phase: 'unknown' as const, createdAt: '2026-10-23T11:00:00.000Z' }
    const held = { operationId: 'op_cccccccc', phase: 'unknown' as const, createdAt: '2026-10-23T11:30:00.000Z' }
    const h = harness({ pending: held })
    h.readFails = true
    await h.core.restore()
    h.readFails = false
    h.deferReads = true

    const older = h.core.transcribe(payload('op_ssssssss'))
    const newer = h.core.transcribe(payload('op_uuuuuuuu'))
    await Promise.resolve()
    await Promise.resolve()
    expect(h.pendingReads).toHaveLength(2)

    // The newer attempt reads the record that is really there and adopts it.
    h.pendingReads.pop()?.({ available: true, pending: held })
    h.deferReads = false
    await newer
    expect((await h.core.status()).pendingOperationId).toBe('op_cccccccc')

    // The older read lands with what it saw before that.
    h.pendingReads.shift()?.({ available: true, pending: stale })
    await older
    expect((await h.core.status()).pendingOperationId).toBe('op_cccccccc')
    expect((await h.core.acknowledgeUnknown(JSON.stringify({ operationId: 'op_cccccccc' }))).ok).toBe(true)
  })

  it('does not reopen a gate an upload has just claimed', async () => {
    // The null-id acknowledgement decides before awaiting its read. An upload can heal the
    // gate, claim it and record its operation in that window; reporting an open gate then
    // would prompt a second recording that the host refuses as an unknown outcome, and the
    // erase would destroy the live operation's only record.
    const h = harness()
    h.readFails = true
    await h.core.restore()
    h.readFails = false
    h.deferReads = true

    const ack = h.core.acknowledgeUnknown(JSON.stringify({ operationId: null }))
    await Promise.resolve()
    await Promise.resolve()
    expect(h.pendingReads).toHaveLength(1)

    let releaseUpload: (() => void) | undefined
    h.transcribeHold = new Promise<void>((resolve) => { releaseUpload = resolve })
    const upload = h.core.transcribe(payload('op_aaaaaaaa'))
    await Promise.resolve()
    await Promise.resolve()
    expect(h.pendingReads).toHaveLength(2)
    h.pendingReads.pop()?.({ available: true, pending: null })
    h.deferReads = false
    await Promise.resolve()
    await Promise.resolve()
    expect((await h.core.status()).gate).toBe('busy')

    // The acknowledgement's read now reports the medium as unreadable.
    h.pendingReads.shift()?.({ available: false })
    const result = await ack
    expect(result.pendingOperationId).toBe('op_aaaaaaaa')
    const after = await h.core.status()
    expect(after.gate).toBe('busy')
    expect(after.pendingOperationId).toBe('op_aaaaaaaa')
    const journalState = await h.journal.read()
    expect(journalState.available && journalState.pending?.operationId).toBe('op_aaaaaaaa')

    releaseUpload?.()
    await upload
  })

  it('adopts a record when the erase is refused because it appeared late', async () => {
    // A refusal and a failure are different: the medium failing to open for this request
    // does not mean it stays unreadable, and the record it could not read may be readable
    // now. Reporting an unavailable medium would leave the user nothing to match.
    const h = harness({ pending: { operationId: 'op_rrrrrrrr', phase: 'unknown', createdAt: '2026-10-23T13:00:00.000Z' } })
    h.readFails = true
    await h.core.restore()
    h.readFails = false
    h.deferReads = true

    const ack = h.core.acknowledgeUnknown(JSON.stringify({ operationId: null }))
    await Promise.resolve()
    await Promise.resolve()
    h.pendingReads.shift()?.({ available: false })
    h.deferReads = false

    const refused = await ack
    expect(refused.ok).toBe(false)
    expect(refused.failure?.code).toBe('conflict')
    expect(refused.pendingOperationId).toBe('op_rrrrrrrr')
  })

  it('leaves a gate alone when something claims it while the erase is in flight', async () => {
    // The erase is asynchronous too. An upload can heal, claim and record between the
    // pre-erase check and the erase landing; opening the gate then would report a free
    // composer over a live upload.
    const h = harness()
    h.readFails = true
    await h.core.restore()
    h.readFails = false
    h.deferReads = true
    h.deferReset = true

    const ack = h.core.acknowledgeUnknown(JSON.stringify({ operationId: null }))
    await Promise.resolve()
    await Promise.resolve()
    h.pendingReads.shift()?.({ available: false })
    await Promise.resolve()
    await Promise.resolve()
    expect(h.pendingResets).toHaveLength(1)

    let releaseUpload: (() => void) | undefined
    h.transcribeHold = new Promise<void>((resolve) => { releaseUpload = resolve })
    const upload = h.core.transcribe(payload('op_bbbbbbbb'))
    await Promise.resolve()
    await Promise.resolve()
    h.pendingReads.shift()?.({ available: true, pending: null })
    h.deferReads = false
    await Promise.resolve()
    await Promise.resolve()
    expect((await h.core.status()).gate).toBe('busy')

    h.pendingResets.shift()?.(true)
    const result = await ack
    expect(result.ok).toBe(true)
    expect(result.pendingOperationId).toBe('op_bbbbbbbb')
    const after = await h.core.status()
    expect(after.gate).toBe('busy')
    expect(after.pendingOperationId).toBe('op_bbbbbbbb')

    releaseUpload?.()
    await upload
  })

  it('adopts a live upload when the erase was refused while it claimed', async () => {
    // The refusal path awaits a second read before it decides, and an upload can heal the
    // gate, claim it and record its operation during that read. Reporting an unavailable
    // medium then would tell the user their storage is broken while an upload is running.
    const h = harness()
    h.readFails = true
    await h.core.restore()
    h.readFails = false
    h.deferReads = true
    h.deferReset = true

    const ack = h.core.acknowledgeUnknown(JSON.stringify({ operationId: null }))
    await Promise.resolve()
    await Promise.resolve()
    h.pendingReads.shift()?.({ available: false })
    await Promise.resolve()
    await Promise.resolve()
    h.pendingResets.shift()?.(false)
    await Promise.resolve()
    await Promise.resolve()
    expect(h.pendingReads).toHaveLength(1)

    const upload = h.core.transcribe(payload('op_bbbbbbbb'))
    await Promise.resolve()
    await Promise.resolve()
    h.pendingReads.pop()?.({ available: true, pending: null })
    await Promise.resolve()
    await Promise.resolve()
    expect((await h.core.status()).gate).toBe('busy')

    h.pendingReads.shift()?.({ available: false })
    const result = await ack
    expect(result.ok).toBe(true)
    expect(result.pendingOperationId).toBe('op_bbbbbbbb')
    expect((await h.core.status()).gate).toBe('busy')

    h.deferReads = false
    const journalState = await h.journal.read()
    h.pendingReads.shift()?.({ available: true, pending: journalState.available ? journalState.pending : null })
    await upload
  })

  it('answers with the live upload when its record lands during the pre-erase read', async () => {
    // The pre-erase read is issued before the upload's own reads, so it can resolve last and
    // observe a record written after it was issued. Adopting that record would answer with a
    // conflict - "refresh and retry" - over an upload that is running fine.
    const h = harness()
    const tick = async (times = 1): Promise<void> => {
      for (let index = 0; index < times; index += 1) await Promise.resolve()
    }
    h.readFails = true
    await h.core.restore()
    h.readFails = false
    h.deferReads = true

    const ack = h.core.acknowledgeUnknown(JSON.stringify({ operationId: null }))
    await tick(2)
    expect(h.pendingReads).toHaveLength(1)

    let releaseUpload: (() => void) | undefined
    h.transcribeHold = new Promise<void>((resolve) => { releaseUpload = resolve })
    const upload = h.core.transcribe(payload('op_bbbbbbbb'))
    await tick(2)
    // The acknowledgement's read is first, the upload's recovery read second.
    expect(h.pendingReads).toHaveLength(2)
    h.pendingReads.pop()?.({ available: true, pending: null })
    await tick(6)
    expect((await h.core.status()).gate).toBe('busy')

    // Claim is done and the upload is inside its own read; its record is not written yet.
    expect(h.pendingReads).toHaveLength(2)
    h.pendingReads.pop()?.({ available: true, pending: null })
    await tick(6)

    h.deferReads = false
    const settled = await h.journal.read()
    expect(settled.available && settled.pending?.operationId).toBe('op_bbbbbbbb')
    h.pendingReads.shift()?.({ available: true, pending: settled.available ? settled.pending : null })

    const result = await ack
    expect(result.ok).toBe(true)
    expect(result.pendingOperationId).toBe('op_bbbbbbbb')
    expect((await h.core.status()).gate).toBe('busy')

    releaseUpload?.()
    await upload
  })

  it('leaves a gate alone when something claims it while the id-matched clear is in flight', async () => {
    // The same window as the erase path, on the concrete-id path: the clear is asynchronous,
    // and an upload that heals the gate during it must not have its claim overwritten.
    const h = harness({ pending: { operationId: 'op_cccccccc', phase: 'unknown', createdAt: '2026-10-23T14:00:00.000Z' } })
    const tick = async (times = 1): Promise<void> => {
      for (let index = 0; index < times; index += 1) await Promise.resolve()
    }
    h.readFails = true
    await h.core.restore()
    h.readFails = false
    const adopted = await h.core.acknowledgeUnknown(JSON.stringify({ operationId: null }))
    expect(adopted.pendingOperationId).toBe('op_cccccccc')

    h.deferClear = true
    const ack = h.core.acknowledgeUnknown(JSON.stringify({ operationId: 'op_cccccccc' }))
    await tick(2)
    expect(h.pendingClears).toHaveLength(1)

    // The clear has written, so the slot reads empty: this upload heals the gate and claims it.
    h.deferReads = true
    let releaseUpload: (() => void) | undefined
    h.transcribeHold = new Promise<void>((resolve) => { releaseUpload = resolve })
    const upload = h.core.transcribe(payload('op_dddddddd'))
    await tick(2)
    h.pendingReads.shift()?.({ available: true, pending: null })
    await tick(6)
    expect((await h.core.status()).gate).toBe('busy')
    expect((await h.core.status()).pendingOperationId).toBe('op_dddddddd')

    h.pendingClears.shift()?.(true)
    const result = await ack
    expect(result.ok).toBe(true)
    expect(result.pendingOperationId).toBe('op_dddddddd')
    const after = await h.core.status()
    expect(after.gate).toBe('busy')
    expect(after.pendingOperationId).toBe('op_dddddddd')

    // The settle path clears the record again, so the deferred clear must be released first.
    h.deferClear = false
    h.deferReads = false
    h.pendingReads.shift()?.({ available: true, pending: null })
    releaseUpload?.()
    await upload
  })

  it('accepts both inclusive budget bounds and refuses just outside them', async () => {
    const h = harness()
    for (const timeout of [1_000, 180_000]) {
      const result = await h.core.configure(JSON.stringify({ language: 'auto', requestTimeoutMs: timeout, expectedRevision: 3 }))
      expect(result.ok, String(timeout)).toBe(true)
    }
    for (const timeout of [999, 180_001]) {
      const result = await h.core.configure(JSON.stringify({ language: 'auto', requestTimeoutMs: timeout, expectedRevision: 3 }))
      expect(result.failure?.code, String(timeout)).toBe('bad-request')
    }
  })
})

describe('journal descriptor', () => {
  it('uses a unit name the storage backend accepts', () => {
    // The backend rule is /^[a-z][a-z0-9_]*$/: a hyphen makes kv.open() reject the
    // descriptor, which made every upload impossible. `pnpm check:journal` runs the same
    // assertion against the real rule; this keeps the failure local and fast.
    expect(JOURNAL_UNIT).toMatch(/^[a-z][a-z0-9_]*$/)
    expect(JOURNAL_VERSION).toBeGreaterThanOrEqual(1)
  })
})

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
    // The schema bound exists only in the Config schema, and settings.write validates
    // shape rather than min/max: an out-of-range value would be persisted and would then
    // stop the entry activating on the next load.
    expect((await h.core.configure(JSON.stringify({ language: 'auto', requestTimeoutMs: 10, expectedRevision: 3 }))).failure?.code).toBe('bad-request')
    expect((await h.core.configure(JSON.stringify({ language: 'auto', requestTimeoutMs: 999_999_999, expectedRevision: 3 }))).failure?.code).toBe('bad-request')
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

  it('sends nothing and holds the gate when the journal cannot be read', async () => {
    const h = harness()
    h.readFails = true
    const result = await h.core.transcribe(payload('op_dddddddd'))
    expect(result.failure?.code).toBe('journal-unavailable')
    expect(h.sends).toHaveLength(0)
    // Fail-closed: the medium cannot be read, so it cannot be cleared either, and the
    // gate holds the refused operation rather than reopening as if nothing happened.
    expect((await h.core.status()).gate).toBe('unknown')
    expect((await h.core.status()).pendingOperationId).toBe('op_dddddddd')
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

  it('names the real reason when a take is over a ceiling, and never blames the format', async () => {
    // 121 seconds of canonical 16 kHz mono audio: a format the browser produced correctly, refused
    // only because it is longer than the local ceiling. "The recording format was refused" would be a
    // false report of a perfectly well-formed take.
    const tooLong = harness()
    const long = await tooLong.core.transcribe(
      JSON.stringify({ operationId: 'op_llllllll', audioBase64: audio(16_000 * 121) }),
    )
    expect(long.failure?.code).toBe('audio-too-long')
    expect(tooLong.sends).toHaveLength(0)

    // The same distinction for size, with the ceiling coming from the service's own snapshot: a
    // service that admits only 4 KiB makes every take too large, and the user is told that rather
    // than that the format was wrong.
    const tooLarge = harness()
    tooLarge.probe = {
      ok: true,
      capabilities: {
        schemaVersion: 'effective_capabilities_v1',
        transcriptionSupported: true,
        reason: null,
        languages: { status: 'unknown', values: [] },
        limits: { maxUploadBytes: 4_096, maxAudioSeconds: 120 },
      },
    }
    await tooLarge.core.check()
    const large = await tooLarge.core.transcribe(JSON.stringify({ operationId: 'op_kkkkkkkk', audioBase64: audio(3_200) }))
    expect(large.failure?.code).toBe('audio-too-large')
    expect(tooLarge.sends).toHaveLength(0)
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

  it('sends the configured language as a hint while no snapshot is in force', async () => {
    // Nothing has stated which languages exist, so the user's explicit choice is the only
    // evidence available and it is sent; the settings page labels it as unverified.
    const h = harness()
    h.config = { ...CONFIG, language: 'zh' }
    await h.core.transcribe(payload('op_kkkkkkkk'))
    expect(h.sends[0]?.language).toBe('zh')
  })

  it('sends the chosen language as a hint when the service transcribes but lists none', async () => {
    // SpeechRail's own shape: transcription supported, language domain unknown, and a documented
    // `language` hint field. The user's choice is honoured rather than silently dropped.
    const h = harness()
    h.config = { ...CONFIG, language: 'zh' }
    h.probe = {
      ok: true,
      capabilities: {
        schemaVersion: 'effective_capabilities_v1',
        transcriptionSupported: true,
        reason: null,
        languages: { status: 'unknown', values: [] },
        limits: { maxUploadBytes: 1_048_576, maxAudioSeconds: 30 },
      },
    }
    await h.core.check()
    expect((await h.core.status()).languageOptions).toEqual(['auto', 'zh', 'en'])

    await h.core.transcribe(payload('op_kkkkkkkk'))
    expect(h.sends[0]?.language).toBe('zh')
  })

  it('falls back to automatic mode when the service declares transcription unsupported', async () => {
    const h = harness()
    h.config = { ...CONFIG, language: 'zh' }
    h.probe = {
      ok: true,
      capabilities: {
        schemaVersion: 'effective_capabilities_v1',
        transcriptionSupported: false,
        reason: 'no asr model loaded',
        languages: { status: 'unknown', values: [] },
        limits: { maxUploadBytes: 1_048_576, maxAudioSeconds: 30 },
      },
    }
    await h.core.check()
    expect((await h.core.status()).languageOptions).toEqual(['auto'])

    const refused = await h.core.transcribe(payload('op_kkkkkkkk'))
    expect(refused.failure?.code).toBe('unsupported')
    expect(h.sends).toHaveLength(0)
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

  it('recovers a corrupt record only through an explicit null acknowledgement', async () => {
    const h = harness()
    h.corrupt = true
    await h.core.restore()
    expect((await h.core.status()).gate).toBe('unknown')
    expect((await h.core.status()).pendingOperationId).toBeNull()

    // Nothing can be matched, so any concrete id is refused rather than accepted.
    const wrong = await h.core.acknowledgeUnknown(JSON.stringify({ operationId: 'op_iiiiiiii' }))
    expect(wrong.failure?.code).toBe('conflict')

    const reset = await h.core.acknowledgeUnknown(JSON.stringify({ operationId: null }))
    expect(reset).toEqual({ ok: true, pendingOperationId: null, failure: null })
    expect((await h.core.status()).gate).toBe('ready')

    const next = await h.core.transcribe(payload('op_jjjjjjjj'))
    expect(next.ok).toBe(true)
    expect(h.sends).toHaveLength(1)
  })

  it('refuses a null acknowledgement when the medium cannot be written', async () => {
    const h = harness()
    h.readFails = true
    h.recordFails = true
    await h.core.restore()
    const refused = await h.core.acknowledgeUnknown(JSON.stringify({ operationId: null }))
    expect(refused.failure?.code).toBe('journal-unavailable')
    expect((await h.core.status()).gate).toBe('unknown')
  })

  it('reports an unreadable medium instead of inventing an unproven upload', async () => {
    // Without the distinction this refusal claimed unknown-outcome, i.e. it presented a
    // storage failure as "an earlier upload may have happened".
    const h = harness()
    h.readFails = true
    await h.core.restore()
    const result = await h.core.transcribe(payload('op_vvvvvvvv'))
    expect(result.ok).toBe(false)
    expect(result.failure?.code).toBe('journal-unavailable')
    expect(h.sends).toHaveLength(0)
  })

  it('does not erase a readable record when the earlier read failed transiently', async () => {
    // The gate opened on a read failure, so this host holds no id. A null
    // acknowledgement must still re-read before writing: the medium may be readable
    // now, and reset() only writes.
    const h = harness({ pending: { operationId: 'op_tttttttt', phase: 'pending', createdAt: '2026-10-23T12:30:00.000Z' } })
    h.readFails = true
    await h.core.restore()
    expect((await h.core.status()).pendingOperationId).toBeNull()

    h.readFails = false
    const refused = await h.core.acknowledgeUnknown(JSON.stringify({ operationId: null }))
    expect(refused.ok).toBe(false)
    expect(refused.failure?.code).toBe('conflict')
    expect(refused.pendingOperationId).toBe('op_tttttttt')
    expect((await h.core.status()).gate).toBe('unknown')

    const cleared = await h.core.acknowledgeUnknown(JSON.stringify({ operationId: 'op_tttttttt' }))
    expect(cleared.ok).toBe(true)
    expect(await h.journal.read()).toEqual({ available: true, pending: null })
  })

  it('refuses a null acknowledgement while a concrete operation is held', async () => {
    // The record is readable, so only the matching id may clear it: a null would
    // erase the durable evidence that an upload's outcome is still unknown.
    const h = harness()
    h.fail = unknownFailure('timeout')
    await h.core.transcribe(payload('op_ssssssss'))
    const status = await h.core.status()
    expect(status.gate).toBe('unknown')
    expect(status.pendingOperationId).toBe('op_ssssssss')

    const refused = await h.core.acknowledgeUnknown(JSON.stringify({ operationId: null }))
    expect(refused.failure?.code).toBe('conflict')
    expect((await h.core.status()).gate).toBe('unknown')
    expect((await h.core.status()).pendingOperationId).toBe('op_ssssssss')

    const cleared = await h.core.acknowledgeUnknown(JSON.stringify({ operationId: 'op_ssssssss' }))
    expect(cleared.ok).toBe(true)
    expect((await h.core.status()).gate).toBe('ready')
  })

  it('runs one probe for concurrent checks and commits the same result to both', async () => {
    // Two clients pressing Check at once used to race: the probe that resolved last won,
    // even when it had started first and carried an older, wider snapshot.
    const h = harness()
    const first = h.core.check()
    const second = h.core.check()
    const [a, b] = await Promise.all([first, second])
    expect(h.probeCalls).toBe(1)
    expect(a).toEqual(b)

    // Once it settles, the next check probes again.
    await h.core.check()
    expect(h.probeCalls).toBe(2)
  })

  it('refuses an upload before sending when the service states transcription is unsupported', async () => {
    const h = harness()
    h.probe = {
      ok: true,
      capabilities: {
        schemaVersion: 'effective_capabilities_v1',
        transcriptionSupported: false,
        reason: 'disabled',
        languages: { status: 'supported', values: ['zh', 'en'] },
        limits: { maxUploadBytes: 1_048_576, maxAudioSeconds: 30 },
      },
    }
    await h.core.check()
    const result = await h.core.transcribe(payload('op_uuuuuuuu'))
    expect(result.ok).toBe(false)
    expect(result.failure?.code).toBe('unsupported')
    expect(h.sends).toHaveLength(0)
    // The gate is not held: nothing was uploaded, so a later attempt may proceed.
    expect((await h.core.status()).gate).toBe('ready')
  })

  it('keeps a service without the capability endpoint usable for transcription', async () => {
    // The compatibility path end to end: the engine only transcribes, so the probe reports
    // `capabilities-absent`, no snapshot is in force, and an upload still goes through.
    const h = harness()
    h.probe = { ok: false, reachable: true, authenticated: 'unverified', failure: failure('capabilities-absent', { httpStatus: 404 }) }
    const check = await h.core.check()
    expect(check.failure?.code).toBe('capabilities-absent')
    expect(check.reachable).toBe(true)
    expect(check.authenticated).toBe('unverified')
    expect(check.capabilities).toBeNull()

    const view = await h.core.status()
    expect(view.languageOptions).toEqual(['auto', 'zh', 'en'])
    expect(view.limits).toEqual({ maxUploadBytes: 4_194_304, maxAudioSeconds: 120 })

    const result = await h.core.transcribe(payload('op_cap00001'))
    expect(result.ok).toBe(true)
    expect(result.failure).toBeNull()
    expect(h.sends).toHaveLength(1)
    expect((await h.core.status()).gate).toBe('ready')
  })

  it('does not clear an unproven gate when the service reports no capabilities', async () => {
    // The compatibility probe says nothing about an upload whose outcome is unproven, so it
    // must not be able to release the gate; only the acknowledgement can.
    const h = harness({ pending: { operationId: 'op_cap00002', phase: 'unknown', createdAt: '2026-10-23T15:00:00.000Z' } })
    await h.core.restore()
    expect((await h.core.status()).gate).toBe('unknown')

    h.probe = { ok: false, reachable: true, authenticated: 'unverified', failure: failure('capabilities-absent', { httpStatus: 404 }) }
    const check = await h.core.check()
    expect(check.failure?.code).toBe('capabilities-absent')

    const after = await h.core.status()
    expect(after.gate).toBe('unknown')
    expect(after.pendingOperationId).toBe('op_cap00002')
    // And the gate still refuses a new upload until it is acknowledged.
    const refused = await h.core.transcribe(payload('op_cap00003'))
    expect(refused.failure?.code).toBe('unknown-outcome')
    expect(h.sends).toHaveLength(0)
  })

  it('never widens the enforced limits when a probe answers without a snapshot', async () => {
    const h = harness()
    h.probe = {
      ok: true,
      capabilities: {
        schemaVersion: 'effective_capabilities_v1',
        transcriptionSupported: true,
        reason: null,
        languages: { status: 'supported', values: ['zh'] },
        limits: { maxUploadBytes: 1_048_576, maxAudioSeconds: 30 },
      },
    }
    await h.core.check()
    expect((await h.core.status()).limits).toEqual({ maxUploadBytes: 1_048_576, maxAudioSeconds: 30 })

    // The service answers 200 with a body this bundle cannot recognise.
    h.probe = { ok: true, capabilities: null }
    await h.core.check()
    expect((await h.core.status()).limits).toEqual({ maxUploadBytes: 1_048_576, maxAudioSeconds: 30 })

    // An unreachable service must not widen them either.
    h.probe = { ok: false, reachable: false, authenticated: 'unverified', failure: failure('unreachable') }
    await h.core.check()
    expect((await h.core.status()).limits).toEqual({ maxUploadBytes: 1_048_576, maxAudioSeconds: 30 })
  })

  it('reports a failed pending write instead of leaving a phantom record', async () => {
    const h = harness()
    h.recordFails = true
    const result = await h.core.transcribe(payload('op_kkkkkkkk'))
    expect(result.failure?.code).toBe('journal-unavailable')
    expect(h.sends).toHaveLength(0)
    expect((await h.core.status()).gate).toBe('ready')
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
