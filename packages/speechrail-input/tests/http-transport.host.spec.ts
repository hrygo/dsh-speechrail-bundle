/**
 * Transport behaviour against a real loopback HTTP server.
 *
 * These tests drive the actual socket layer instead of a fake, so the claims that
 * matter for safety are executed: no redirect is followed, the response is
 * byte-capped, a deadline or cancellation after the body was written is reported as
 * an unproven outcome, and no failure ever carries the credential.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createSocketServer, type Socket } from 'node:net'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { probeCapabilities, transcribe, unbracketHostname } from '../src/host/http.ts'
import { encodeWave } from '../src/protocol/wave.ts'
import { TRANSCRIPTION_RESPONSE_MAX_BYTES } from '../src/contracts.ts'

const AUDIO = encodeWave(new Float32Array(1_600))
const SECRET = 'local-secret-token'

interface Server {
  readonly baseUrl: string
  readonly requests: Request[]
  close(): Promise<void>
}

/** Servers the cleanup hook still has to close. */
const open: Server[] = []

interface Request {
  readonly method: string
  readonly url: string
  readonly headers: IncomingMessage['headers']
  readonly body: Buffer
}

/** Start one loopback server whose reply is decided per test. */
async function serve(handler: (request: Request, response: ServerResponse) => void): Promise<Server> {
  const requests: Request[] = []
  const server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = []
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
    incoming.on('end', () => {
      const request: Request = {
        method: incoming.method ?? '',
        url: incoming.url ?? '',
        headers: incoming.headers,
        body: Buffer.concat(chunks),
      }
      requests.push(request)
      handler(request, outgoing)
    })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
    requests,
    close: async () => { await new Promise<void>((resolve, reject) => { server.close((error) => { error ? reject(error) : resolve() }) }) },
  }
}

async function start(handler: (request: Request, response: ServerResponse) => void): Promise<Server> {
  const server = await serve(handler)
  open.push(server)
  return server
}

/** Close a server inside its own test and drop it from the cleanup list. */
async function stop(server: Server): Promise<void> {
  const index = open.indexOf(server)
  if (index >= 0) open.splice(index, 1)
  await server.close()
}

afterEach(async () => {
  await Promise.all(open.splice(0).map(async (server) => { await server.close() }))
})

describe('transcription transport', () => {
  it('sends the canonical form and reads the transcript', async () => {
    const server = await start((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ text: '你好世界', usage: { type: 'duration', seconds: 0.42 } }))
    })
    const outcome = await transcribe({
      baseUrl: server.baseUrl,
      model: 'asr-1.7b-q8',
      language: 'zh',
      credential: SECRET,
      audio: AUDIO,
      timeoutMs: 5_000,
    })

    expect(outcome).toEqual({ ok: true, text: '你好世界', requestSeconds: expect.any(Number) as number })
    const [request] = server.requests
    expect(request?.url).toBe('/v1/audio/transcriptions')
    expect(request?.headers.authorization).toBe(`Bearer ${SECRET}`)
    expect(request?.headers['content-type']).toContain('multipart/form-data; boundary=')
    const body = request?.body.toString('latin1') ?? ''
    expect(body).toContain('name="response_format"')
    expect(body).toContain('name="model"')
    expect(body).toContain('name="language"')
    expect(body).toContain('name="file"; filename="recording.wav"')
  })

  it('omits language and model when they are unset', async () => {
    const server = await start((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ text: 'ok', usage: { type: 'duration', seconds: 0.1 } }))
    })
    await transcribe({ baseUrl: server.baseUrl, model: '', language: null, credential: SECRET, audio: AUDIO, timeoutMs: 5_000 })
    const body = server.requests[0]?.body.toString('latin1') ?? ''
    expect(body).not.toContain('name="language"')
    expect(body).not.toContain('name="model"')
  })

  it('refuses an unauthorized response without leaking the credential', async () => {
    const server = await start((_request, response) => {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'bad key ' + SECRET } }))
    })
    const outcome = await transcribe({ baseUrl: server.baseUrl, model: '', language: null, credential: SECRET, audio: AUDIO, timeoutMs: 5_000 })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('unreachable')
    expect(outcome.failure.code).toBe('unauthorized')
    expect(outcome.failure.httpStatus).toBe(401)
    expect(JSON.stringify(outcome.failure)).not.toContain(SECRET)
  })

  it('does not follow a redirect', async () => {
    const target = await start((_request, response) => { response.writeHead(200); response.end('{}') })
    const origin = await start((_request, response) => {
      response.writeHead(302, { location: `${target.baseUrl}/audio/transcriptions` })
      response.end()
    })
    const outcome = await transcribe({ baseUrl: origin.baseUrl, model: '', language: null, credential: SECRET, audio: AUDIO, timeoutMs: 5_000 })
    expect(outcome.ok).toBe(false)
    // The redirect target must never see the request, and therefore never the bearer.
    expect(target.requests).toHaveLength(0)
    expect(origin.requests).toHaveLength(1)
  })

  it('caps the response body instead of buffering it', async () => {
    const server = await start((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(`{"text":"${'a'.repeat(TRANSCRIPTION_RESPONSE_MAX_BYTES)}"}`)
    })
    const outcome = await transcribe({ baseUrl: server.baseUrl, model: '', language: null, credential: SECRET, audio: AUDIO, timeoutMs: 10_000 })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('unreachable')
    expect(outcome.failure.code).toBe('malformed-response')
  })

  it('rejects a body that is not a transcript', async () => {
    const server = await start((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"text":"x","usage":{"type":"duration","seconds":-1}}')
    })
    const outcome = await transcribe({ baseUrl: server.baseUrl, model: '', language: null, credential: SECRET, audio: AUDIO, timeoutMs: 5_000 })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('unreachable')
    expect(outcome.failure.code).toBe('malformed-response')
  })

  it('reports a deadline after the upload as an unproven outcome', async () => {
    const server = await start(() => {
      // Never answers: the request body landed, the reply never did.
    })
    const outcome = await transcribe({ baseUrl: server.baseUrl, model: '', language: null, credential: SECRET, audio: AUDIO, timeoutMs: 150 })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('unreachable')
    expect(outcome.failure.code).toBe('timeout')
    // Unproven, not failed: the core gate is what forbids replay, not the advisory
    // retryable flag, so only the outcome is asserted here.
    expect(outcome.failure.outcome).toBe('unknown')
  })

  it('reports a cancellation after the upload as an unproven outcome', async () => {
    const server = await start(() => { /* never answers */ })
    const controller = new AbortController()
    const pending = transcribe({
      baseUrl: server.baseUrl,
      model: '',
      language: null,
      credential: SECRET,
      audio: AUDIO,
      timeoutMs: 5_000,
      signal: controller.signal,
    })
    await new Promise((resolve) => { setTimeout(resolve, 60) })
    controller.abort()
    const outcome = await pending
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('unreachable')
    expect(outcome.failure.code).toBe('cancelled')
    expect(outcome.failure.outcome).toBe('unknown')
  })

  it('reports an unreachable service without any response', async () => {
    const server = await start(() => { /* unused */ })
    const baseUrl = server.baseUrl
    await stop(server)
    const outcome = await transcribe({ baseUrl, model: '', language: null, credential: SECRET, audio: AUDIO, timeoutMs: 500 })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('unreachable')
    expect(outcome.failure.code).toBe('unreachable')
    // Nothing was delivered, so the outcome is a plain failure rather than unproven.
    expect(outcome.failure.outcome).toBe('failed')
  })
})

describe('capability probe', () => {
  it('classifies an unauthorized probe', async () => {
    const server = await start((_request, response) => { response.writeHead(401); response.end() })
    const outcome = await probeCapabilities({ baseUrl: server.baseUrl, credential: SECRET, timeoutMs: 2_000 })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('unreachable')
    expect(outcome.reachable).toBe(true)
    expect(outcome.authenticated).toBe(false)
    expect(outcome.failure?.code).toBe('unauthorized')
  })

  it('projects a well-formed snapshot and bounds it with the absolute ceilings', async () => {
    const server = await start((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        schema_version: 'effective_capabilities_v1',
        operations: {
          transcription: {
            status: 'supported',
            languages: { status: 'supported', values: ['zh', 'en'] },
            input: { max_upload_bytes: 1_048_576, max_audio_seconds: 30 },
            output: { formats: ['json'] },
          },
        },
      }))
    })
    const outcome = await probeCapabilities({ baseUrl: server.baseUrl, credential: SECRET, timeoutMs: 2_000 })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('unreachable')
    expect(outcome.capabilities?.schemaVersion).toBe('effective_capabilities_v1')
    expect(outcome.capabilities?.limits).toEqual({ maxUploadBytes: 1_048_576, maxAudioSeconds: 30 })
    expect(outcome.capabilities?.languages).toEqual({ status: 'supported', values: ['zh', 'en'] })
  })

  it('unbrackets an IPv6 literal so a loopback request stays on loopback', () => {
    // `new URL('http://[::1]:1/').hostname` is '[::1]', which Node resolves as a name.
    expect(unbracketHostname('[::1]')).toBe('::1')
    expect(unbracketHostname('127.0.0.1')).toBe('127.0.0.1')
    expect(unbracketHostname('localhost')).toBe('localhost')
  })

  it('reports a service that answered as reachable when its body never arrives', async () => {
    // The response head proves the service is up; a stall after it must not be reported
    // as an unreachable service.
    const server = await start((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.write('{"transcription"')
    })
    const outcome = await probeCapabilities({ baseUrl: server.baseUrl, credential: SECRET, timeoutMs: 300 })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('unreachable')
    expect(outcome.failure?.code).toBe('timeout')
    expect(outcome.reachable).toBe(true)
  })

  it('counts an informational response as an answer too', async () => {
    // Node reports 1xx on its own event; a 103 followed by a stall still proves the
    // service is there.
    const sockets = new Set<Socket>()
    const server = createSocketServer((socket) => {
      sockets.add(socket)
      socket.on('close', () => { sockets.delete(socket) })
      socket.write('HTTP/1.1 103 Early Hints\r\n\r\n')
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    try {
      const port = (server.address() as AddressInfo).port
      const outcome = await probeCapabilities({ baseUrl: `http://127.0.0.1:${String(port)}/v1`, credential: SECRET, timeoutMs: 300 })
      expect(outcome.ok).toBe(false)
      if (outcome.ok) throw new Error('unreachable')
      expect(outcome.failure?.code).toBe('timeout')
      expect(outcome.reachable).toBe(true)
    } finally {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    }
  })

  it('reports a response that arrived as reachable even when its body is refused', async () => {
    const server = await start((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('x'.repeat(300_000))
    })
    const outcome = await probeCapabilities({ baseUrl: server.baseUrl, credential: SECRET, timeoutMs: 5_000 })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('unreachable')
    expect(outcome.failure?.code).toBe('malformed-response')
    expect(outcome.reachable).toBe(true)
  })

  it('reports a service that declares transcription unsupported as unusable', async () => {
    // The end-to-end shape the run path refuses on: a real 200 body, projected, must
    // come back with transcriptionSupported false and no admitted language.
    const server = await start((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        schema_version: 'effective_capabilities_v1',
        operations: {
          transcription: {
            status: 'unsupported',
            reason: 'disabled',
            languages: { status: 'supported', values: ['zh', 'en'] },
            input: { max_upload_bytes: 1_048_576, max_audio_seconds: 30 },
          },
        },
      }))
    })
    const outcome = await probeCapabilities({ baseUrl: server.baseUrl, credential: SECRET, timeoutMs: 2_000 })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('unreachable')
    expect(outcome.capabilities?.transcriptionSupported).toBe(false)
    expect(outcome.capabilities?.languages).toEqual({ status: 'unknown', values: [] })
    expect(outcome.capabilities?.reason).toBe('disabled')
  })

  it('keeps the limits in force when a recognized snapshot states none', async () => {
    // A 200 that recognises the transcription endpoint but omits its input limits must
    // not lift enforcement to the absolute ceilings: the previous snapshot stays the
    // authority for every limit this one does not state.
    let body = JSON.stringify({
      schema_version: 'effective_capabilities_v1',
      operations: { transcription: { status: 'supported', input: { max_upload_bytes: 1_048_576, max_audio_seconds: 30 } } },
    })
    const server = await start((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(body)
    })

    const tight = await probeCapabilities({ baseUrl: server.baseUrl, credential: SECRET, timeoutMs: 2_000 })
    expect(tight.ok).toBe(true)
    if (!tight.ok) throw new Error('unreachable')
    expect(tight.capabilities?.limits).toEqual({ maxUploadBytes: 1_048_576, maxAudioSeconds: 30 })

    body = JSON.stringify({ operations: { transcription: { status: 'supported' } } })
    const recognized = await probeCapabilities({
      baseUrl: server.baseUrl,
      credential: SECRET,
      timeoutMs: 2_000,
      previousLimits: tight.capabilities?.limits ?? null,
    })
    expect(recognized.ok).toBe(true)
    if (!recognized.ok) throw new Error('unreachable')
    expect(recognized.capabilities).not.toBeNull()
    expect(recognized.capabilities?.limits).toEqual({ maxUploadBytes: 1_048_576, maxAudioSeconds: 30 })

    // An explicitly stated limit still takes effect, so the snapshot remains authoritative.
    body = JSON.stringify({ operations: { transcription: { input: { max_upload_bytes: 524_288, max_audio_seconds: 15 } } } })
    const tightened = await probeCapabilities({
      baseUrl: server.baseUrl,
      credential: SECRET,
      timeoutMs: 2_000,
      previousLimits: recognized.capabilities?.limits ?? null,
    })
    expect(tightened.ok).toBe(true)
    if (!tightened.ok) throw new Error('unreachable')
    expect(tightened.capabilities?.limits).toEqual({ maxUploadBytes: 524_288, maxAudioSeconds: 15 })
  })

  it('accepts an unrecognized body as an empty capability view rather than failing', async () => {
    // Deliberate: the snapshot is used opportunistically. A body this bundle does not
    // understand yields no limits, and enforcement falls back to the absolute ceilings.
    const server = await start((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{}')
    })
    const outcome = await probeCapabilities({ baseUrl: server.baseUrl, credential: SECRET, timeoutMs: 2_000 })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('unreachable')
    expect(outcome.capabilities).toBeNull()
  })

  it('reports an unreachable service', async () => {
    const server = await start(() => { /* unused */ })
    const baseUrl = server.baseUrl
    await stop(server)
    const outcome = await probeCapabilities({ baseUrl, credential: SECRET, timeoutMs: 500 })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('unreachable')
    expect(outcome.reachable).toBe(false)
  })
})
