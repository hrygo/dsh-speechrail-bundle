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
import { createStatusTool, describeStatus, type StatusToolValue } from '../src/host/tools.ts'
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

    expect((await core.status()).languageOptions).toEqual(['auto'])
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
  it('honours the chosen language when the service transcribes but lists none', async () => {
    // The shape SpeechRail itself answers with, and the case that matters most: an endpoint that
    // transcribes but never enumerated its languages still documents `language` as a hint.
    const service = await engine({
      capabilities: (response) => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          schema_version: 'effective_capabilities_v1',
          operations: { transcription: { status: 'supported', languages: { status: 'unknown' } } },
        }))
      },
      transcription: (_request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ text: 'quiet' }))
      },
    })
    const core = coreOver(service, 'zh')
    await core.check()
    expect((await core.status()).languageOptions).toEqual(['auto', 'zh', 'en'])

    await core.transcribe(payload('op_ge0000003'))
    expect(fieldOf(service.posts[0] ?? '', 'language')).toBe('zh')
  })

  it('transcribes with package defaults while no snapshot is in force', async () => {
    const service = await plainEngine()
    const core = coreOver(service, 'zh')

    const check = await core.check()
    expect(check.reachable).toBe(true)
    expect(check.authenticated).toBe('unverified')
    expect(check.failure?.code).toBe('capabilities-absent')
    expect(check.capabilities).toBeNull()

    const view = await core.status()
    expect(view.limits).toEqual(DEFAULT_LIMITS)
    // Nothing spoke about languages, so the user's explicit choice is offered as a hint.
    expect(view.languageOptions).toEqual(['auto', 'zh', 'en'])

    const result = await core.transcribe(payload('op_ge0000001'))
    expect(result.ok).toBe(true)
    expect(result.transcript?.text).toBe('plain engine')
    expect(result.transcript?.inferenceSeconds).toBeNull()
    // `zh` is configured and nothing contradicted it, so it travels as an unverified hint:
    // Whisper-class engines use it, and an engine that rejects it answers with its own error.
    expect(fieldOf(service.posts[0] ?? '', 'language')).toBe('zh')
    expect((await core.status()).gate).toBe('ready')
  })

  it('reports the language the wire will carry, never the one that was configured', async () => {
    // The tool's own description promises the language in force. Before this, a snapshot that
    // admitted only `en` still made it report `zh` while the upload carried no language at all.
    const service = await engine({
      capabilities: (response) => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          schema_version: 'effective_capabilities_v1',
          operations: {
            transcription: {
              status: 'supported',
              languages: { status: 'supported', values: ['en'] },
              input: { max_upload_bytes: 1_048_576, max_audio_seconds: 30 },
            },
          },
        }))
      },
      transcription: (_request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('{"text":"ok"}')
      },
    })
    const core = coreOver(service, 'zh')
    const value = await createStatusTool(core).execute({ probe: true }) as StatusToolValue
    expect(value.language).toBe('zh')
    expect(value.languageHint).toBe('')
    expect(value.languageOptions).toEqual(['auto', 'en'])
    expect(describeStatus(value)).toContain('language zh with no hint in force')

    // And the wire agrees with the line the agent was given.
    await core.transcribe(payload('op_ge0000004'))
    expect(fieldOf(service.posts[0] ?? '', 'language')).toBeNull()
  })

  it('says out loud that an unsupported snapshot refuses every upload', async () => {
    // `service reachable and authorized` is true of the credential and was read as "usable" while
    // the host refused every upload: the operation's own state is now part of the line.
    const service = await engine({
      capabilities: (response) => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          schema_version: 'effective_capabilities_v1',
          operations: { transcription: { status: 'unsupported', reason: 'asr_not_ready' } },
        }))
      },
      transcription: (_request, response) => { response.writeHead(500).end() },
    })
    const core = coreOver(service, 'zh')
    const value = await createStatusTool(core).execute({ probe: true }) as StatusToolValue
    expect(value.transcriptionSupport).toBe('unsupported')
    expect(value.languageHint).toBe('')
    const text = describeStatus(value)
    expect(text).toContain('transcription unsupported by the service')
    expect(text).toContain('every upload is refused before the audio is sent')
    // The credential verdict still reports what the probe proved, and nothing more.
    expect(value.authenticated).toBe('accepted')
  })

  it('settles the gate on a 401 the service plainly answered', async () => {
    // A proven refusal must not look like an unproven outcome: the user would have to acknowledge
    // an operation the service had already rejected.
    const service = await engine({
      capabilities: (response) => { response.writeHead(404).end() },
      transcription: (_request, response) => {
        response.writeHead(401, { 'content-type': 'application/json' })
        response.end(`{"error":"${'a'.repeat(300_000)}"}`)
      },
    })
    const core = coreOver(service)
    await core.check()
    const result = await core.transcribe(payload('op_ge0000005'))
    expect(result.failure?.code).toBe('unauthorized')
    expect(result.failure?.outcome).toBe('failed')

    const view = await core.status()
    expect(view.gate).toBe('ready')
    expect(view.pendingOperationId).toBeNull()
  })

  it('describes each profile truthfully to the agent that asks', async () => {
    // The agent-facing line once called a transcription-only engine "not accepting the request";
    // it is pinned here for both profiles, over the same real sockets the rest of this file uses.
    const speechrail = await speechrailEngine()
    const speechrailValue = await createStatusTool(coreOver(speechrail)).execute({ probe: true }) as StatusToolValue
    expect(speechrailValue.authenticated).toBe('accepted')
    expect(speechrailValue.failureCode).toBe('')
    expect(describeStatus(speechrailValue)).toContain('service reachable and authorized')

    const plain = await plainEngine()
    const plainValue = await createStatusTool(coreOver(plain)).execute({ probe: true }) as StatusToolValue
    expect(plainValue.authenticated).toBe('unverified')
    expect(plainValue.failureCode).toBe('capabilities-absent')
    const plainText = describeStatus(plainValue)
    expect(plainText).toContain('plain transcription endpoint')
    expect(plainText).not.toContain('not accepting the request')
    // The limits it reports are the ones actually in force, not the service's.
    expect(plainText).toContain(`limits ${String(DEFAULT_LIMITS.maxUploadBytes)} bytes / ${String(DEFAULT_LIMITS.maxAudioSeconds)}s`)
  })

  it('settles only on a status that proves the service refused the request', async () => {
    // The engine reads the whole recording and only then answers. A 504 says a gateway gave up while
    // an upstream worker may still be transcribing, a 500/502 says nothing about the audio, a 302
    // points elsewhere, and 202 means "still working" in so many words: none of those may open the
    // gate, or the user is invited to dictate again over work that may still be running. A 4xx
    // (except 408 Request Timeout) is the service refusing the request itself, and only that settles.
    const stalled: readonly { readonly status: number, readonly settles: boolean }[] = [
      { status: 400, settles: true },
      { status: 401, settles: true },
      { status: 404, settles: true },
      { status: 408, settles: false },
      { status: 500, settles: false },
      { status: 502, settles: false },
      { status: 504, settles: false },
      { status: 302, settles: false },
      { status: 202, settles: false },
      { status: 200, settles: false },
    ]
    for (const shape of stalled) {
      const service = await engine({
        capabilities: (response) => { response.writeHead(404).end() },
        transcription: (_request, response) => {
          response.writeHead(shape.status, { 'content-type': 'application/json' })
          response.flushHeaders()
        },
      })
      const operationId = `op_settle${shape.status}`
      const core = coreOver(service, 'auto', 400)
      await core.check()

      const result = await core.transcribe(payload(operationId))
      expect(result.failure?.outcome, `stalled ${shape.status}`).toBe(shape.settles ? 'failed' : 'unknown')
      expect(result.failure?.httpStatus, `stalled ${shape.status}`).toBe(shape.status)
      const view = await core.status()
      expect(view.gate, `stalled ${shape.status}`).toBe(shape.settles ? 'ready' : 'unknown')
      expect(view.pendingOperationId, `stalled ${shape.status}`).toBe(shape.settles ? null : operationId)
      if (!shape.settles) await core.acknowledgeUnknown(JSON.stringify({ operationId }))
    }
  })

  it('keeps a completed answer on the wire from settling the gate, except a refusal', async () => {
    // The same ladder with a complete body. A 202 Accepted is the sharpest case: the service says in
    // so many words that the work continues. A 200 whose body cannot be used is the deliberate
    // contrast - the service did finish the request, so nothing is in flight and the operation
    // settles as failed, with no acknowledgement demanded for work that provably ended.
    const answered: readonly { readonly status: number, readonly settles: boolean, readonly body?: string }[] = [
      { status: 400, settles: true, body: '{"error":"bad"}' },
      { status: 401, settles: true, body: '{"error":"no"}' },
      { status: 500, settles: false, body: '{"error":"boom"}' },
      { status: 504, settles: false, body: '{"error":"slow"}' },
      { status: 302, settles: false, body: '' },
      { status: 201, settles: false, body: '{"id":"job_1"}' },
      { status: 202, settles: false, body: '{"id":"job_1"}' },
      { status: 204, settles: false, body: '' },
    ]
    for (const shape of answered) {
      const service = await engine({
        capabilities: (response) => { response.writeHead(404).end() },
        transcription: (_request, response) => {
          response.writeHead(shape.status, { 'content-type': 'application/json' })
          response.end(shape.body ?? '')
        },
      })
      const operationId = `op_answer${shape.status}`
      const core = coreOver(service)
      await core.check()

      const result = await core.transcribe(payload(operationId))
      expect(result.failure?.outcome, `answered ${shape.status}`).toBe(shape.settles ? 'failed' : 'unknown')
      const view = await core.status()
      expect(view.gate, `answered ${shape.status}`).toBe(shape.settles ? 'ready' : 'unknown')
      expect(view.pendingOperationId, `answered ${shape.status}`).toBe(shape.settles ? null : operationId)
      if (!shape.settles) await core.acknowledgeUnknown(JSON.stringify({ operationId }))
    }

    // The contrast: a complete 200 the client cannot use ends the operation for good.
    const unusable = await engine({
      capabilities: (response) => { response.writeHead(404).end() },
      transcription: (_request, response) => {
        response.writeHead(200, { 'content-type': 'text/html' })
        response.end('<html>not a transcript</html>')
      },
    })
    const core = coreOver(unusable)
    await core.check()
    const result = await core.transcribe(payload('op_0000html'))
    expect(result.failure?.code).toBe('malformed-response')
    expect(result.failure?.outcome).toBe('failed')
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
