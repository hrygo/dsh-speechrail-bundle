/**
 * Two engine profiles, one contract.
 *
 * The compatibility work added a second kind of engine, so the invariants of both are pinned
 * here side by side over real loopback sockets and the real core assembly:
 *
 * - a SpeechRail engine (capability snapshot + `usage` extension) must not lose anything: its
 *   advertised limits and languages stay in force, its snapshot still gates uploads, and its
 *   language admission still decides what is sent;
 * - a plain OpenAI-shaped engine (no capability endpoint, `{"text": ...}`) must stay usable,
 *   with the package defaults in force and no language the service never admitted.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { SpeechRailInputCore, type CoreDependencies, type ResolvedConfig } from '../src/host/core.ts'
import { DEFAULT_LIMITS } from '../src/host/capabilities.ts'
import { probeCapabilities, transcribe as httpTranscribe } from '../src/host/http.ts'
import type { PendingJournal } from '../src/host/journal.ts'
import { encodeWave } from '../src/protocol/wave.ts'
import type { SpeechRailLimits } from '../src/types.ts'

const AUDIO = encodeWave(new Float32Array(1_600))
const SECRET = 'local-secret-token'

/** One stub engine plus the raw bodies it received. */
interface Engine {
  readonly baseUrl: string
  readonly posts: string[]
  readonly paths: string[]
  close(): Promise<void>
}

const running: Engine[] = []

afterEach(async () => {
  while (running.length > 0) {
    const engine = running.pop()
    if (engine !== undefined) await engine.close()
  }
})

/** Start one loopback engine whose replies are decided per route. */
async function engine(routes: {
  readonly capabilities?: (response: ServerResponse) => void
  readonly transcription?: (request: IncomingMessage, response: ServerResponse, body: string) => void
}): Promise<Engine> {
  const posts: string[] = []
  const paths: string[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      paths.push(request.url ?? '')
      if (request.url === '/v1/audio/transcriptions') {
        posts.push(body)
        routes.transcription?.(request, response, body)
        return
      }
      if (request.url === '/v1/speechrail/capabilities') {
        if (routes.capabilities === undefined) {
          response.writeHead(404).end()
          return
        }
        routes.capabilities(response)
        return
      }
      response.writeHead(404).end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  const entry: Engine = {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    posts,
    paths,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
  running.push(entry)
  return entry
}

/** A healthy local service that states a snapshot, in SpeechRail's shape. */
function speechrailEngine(limits: SpeechRailLimits = { maxUploadBytes: 1_048_576, maxAudioSeconds: 30 }): Promise<Engine> {
  return engine({
    capabilities: (response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        schema_version: 'effective_capabilities_v1',
        operations: {
          transcription: {
            status: 'supported',
            languages: { status: 'supported', values: ['zh', 'en'] },
            input: { max_upload_bytes: limits.maxUploadBytes, max_audio_seconds: limits.maxAudioSeconds },
          },
        },
      }))
    },
    transcription: (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ text: '你好世界', usage: { type: 'duration', seconds: 0.42 } }))
    },
  })
}

/** An engine that only transcribes: no capability endpoint, no `usage` extension. */
function plainEngine(): Promise<Engine> {
  return engine({
    transcription: (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ text: 'plain engine' }))
    },
  })
}

/** The engine under test, assembled exactly like the shipped service. */
function coreOver(
  target: Engine,
  language: ResolvedConfig['language'] = 'auto',
  requestTimeoutMs = 5_000,
): SpeechRailInputCore {
  let pending: { operationId: string; phase: 'pending' | 'unknown'; createdAt: string } | null = null
  const journal: PendingJournal = {
    read: async () => ({ available: true, pending }),
    record: async (entry) => { pending = entry; return true },
    clear: async (operationId) => {
      if (pending !== null && pending.operationId !== operationId) return false
      pending = null
      return true
    },
    reset: async () => { pending = null; return true },
  }
  const config: ResolvedConfig = {
    baseUrl: target.baseUrl,
    endpointRefusal: null,
    model: '',
    credentialRef: 'SPEECHRAIL_API_KEY',
    language,
    requestTimeoutMs,
  }
  const deps: CoreDependencies = {
    now: () => new Date('2026-10-24T12:00:00.000Z'),
    config: () => config,
    resolveCredential: async () => SECRET,
    journal,
    transcribe: async (options) => await httpTranscribe(options),
    probe: async (options) => await probeCapabilities(options),
    settingsRevision: () => 1,
    writeSettings: async () => 'ok',
  }
  return new SpeechRailInputCore(deps)
}

/** Read one multipart field out of a captured request body. */
function fieldOf(body: string, name: string): string | null {
  const match = new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)`, 'u').exec(body)
  return match?.[1] ?? null
}

function payload(operationId: string): string {
  return JSON.stringify({ operationId, audioBase64: Buffer.from(AUDIO).toString('base64') })
}

describe('SpeechRail engine: the service keeps deciding', () => {
  it('keeps its advertised limits, languages and acceptance', async () => {
    const service = await speechrailEngine({ maxUploadBytes: 2_097_152, maxAudioSeconds: 45 })
    const core = coreOver(service)

    const check = await core.check()
    expect(check.reachable).toBe(true)
    expect(check.authenticated).toBe('accepted')
    expect(check.capabilities?.transcriptionSupported).toBe(true)

    const view = await core.status()
    // The service's own numbers stay in force instead of the package defaults.
    expect(view.limits).toEqual({ maxUploadBytes: 2_097_152, maxAudioSeconds: 45 })
    expect(view.languageOptions).toEqual(['auto', 'zh', 'en'])
    expect(view.capabilities?.languages.values).toEqual(['zh', 'en'])
  })

  it('sends the language its snapshot admitted and reads the usage extension', async () => {
    const service = await speechrailEngine()
    const core = coreOver(service, 'zh')
    await core.check()

    const result = await core.transcribe(payload('op_sr0000001'))
    expect(result.ok).toBe(true)
    expect(result.transcript?.operationId).toBe('op_sr0000001')
    expect(result.transcript?.text).toBe('你好世界')
    // The usage extension states a duration; it is deliberately not surfaced as inference time.
    expect(result.transcript?.inferenceSeconds).toBeNull()
    expect(result.transcript?.audioSeconds).toBeCloseTo(0.1, 3)
    expect(fieldOf(service.posts[0] ?? '', 'language')).toBe('zh')
    expect((await core.status()).gate).toBe('ready')
  })

  it('still refuses an upload its snapshot calls unsupported', async () => {
    const service = await engine({
      capabilities: (response) => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          schema_version: 'effective_capabilities_v1',
          operations: { transcription: { status: 'unsupported', reason: 'no asr model loaded' } },
        }))
      },
      transcription: (_request, response) => { response.writeHead(500).end() },
    })
    const core = coreOver(service)
    await core.check()

    const result = await core.transcribe(payload('op_sr0000002'))
    expect(result.ok).toBe(false)
    expect(result.failure?.code).toBe('unsupported')
    // Nothing was uploaded: the refusal happens before the audio leaves the host.
    expect(service.posts).toHaveLength(0)
  })

  it('still reports a refused credential as refused, and a server error as unverified', async () => {
    const unauthorized = await engine({
      capabilities: (response) => { response.writeHead(401).end() },
      transcription: (_request, response) => { response.writeHead(401).end() },
    })
    expect((await coreOver(unauthorized).check()).authenticated).toBe('refused')

    const broken = await engine({
      capabilities: (response) => { response.writeHead(500).end() },
      transcription: (_request, response) => { response.writeHead(500).end() },
    })
    const check = await coreOver(broken).check()
    expect(check.authenticated).toBe('unverified')
    expect(check.failure?.code).toBe('server-error')
  })
})

describe('plain OpenAI-shaped engine: usable without losing the guards', () => {
  it('transcribes with package defaults and no language the service never admitted', async () => {
    const service = await plainEngine()
    const core = coreOver(service, 'zh')

    const check = await core.check()
    expect(check.reachable).toBe(true)
    expect(check.authenticated).toBe('unverified')
    expect(check.failure?.code).toBe('capabilities-absent')
    expect(check.capabilities).toBeNull()

    const view = await core.status()
    expect(view.limits).toEqual(DEFAULT_LIMITS)
    expect(view.languageOptions).toEqual(['auto'])

    const result = await core.transcribe(payload('op_ge0000001'))
    expect(result.ok).toBe(true)
    expect(result.transcript?.text).toBe('plain engine')
    expect(result.transcript?.inferenceSeconds).toBeNull()
    // `zh` is configured but nothing admitted it, so the hint is not invented on the wire.
    expect(fieldOf(service.posts[0] ?? '', 'language')).toBeNull()
    // And the engine is never asked for a capability snapshot it does not have twice per upload.
    expect((await core.status()).gate).toBe('ready')
  })

  it('keeps the journal, the gate and the acknowledgement for an unproven outcome', async () => {
    // The engine accepts the upload and never answers: the outcome cannot be proven, and the
    // local guards must behave exactly as they do against SpeechRail.
    const service = await engine({
      transcription: () => { /* never responds */ },
    })
    // A short request budget so the unproven outcome arrives well inside the test budget.
    const core = coreOver(service, 'auto', 300)
    await core.check()

    const result = await core.transcribe(payload('op_ge0000002'))
    expect(result.failure?.outcome).toBe('unknown')
    const blocked = await core.status()
    expect(blocked.gate).toBe('unknown')
    expect(blocked.pendingOperationId).toBe('op_ge0000002')

    const acknowledged = await core.acknowledgeUnknown(JSON.stringify({ operationId: 'op_ge0000002' }))
    expect(acknowledged.ok).toBe(true)
    expect((await core.status()).gate).toBe('ready')
  })
})
