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
import { performRequest, probeCapabilities, transcribe, unbracketHostname } from '../src/host/http.ts'
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

  it('omits the Authorization header when the endpoint needs no credential', async () => {
    // Omitted rather than sent empty: a `Bearer ` with nothing after it is read as a malformed
    // token by servers that would otherwise ignore the header entirely.
    const server = await start((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ text: '你好世界' }))
    })
    const outcome = await transcribe({
      baseUrl: server.baseUrl,
      model: '',
      language: null,
      credential: null,
      audio: AUDIO,
      timeoutMs: 5_000,
    })

    expect(outcome.ok).toBe(true)
    const [request] = server.requests
    expect(request?.headers.authorization).toBeUndefined()
    expect(request?.headers['content-type']).toContain('multipart/form-data; boundary=')
  })

  it('accepts a transcript that states no usage', async () => {
    // `usage` is SpeechRail's own extension. An OpenAI-compatible engine answers with
    // `{"text": ...}` alone, and nothing downstream reads the duration.
    const server = await start((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ text: '你好世界' }))
    })
    const outcome = await transcribe({ baseUrl: server.baseUrl, model: 'whisper-1', language: null, credential: SECRET, audio: AUDIO, timeoutMs: 5_000 })
    expect(outcome).toEqual({ ok: true, text: '你好世界', requestSeconds: expect.any(Number) as number })
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
    if (outcome.ok) throw new Error('unreachable')
    // Refusing a redirect is this bundle's own rule, so it must not read as an internal fault.
    expect(outcome.failure.code).toBe('redirected')
    expect(outcome.failure.httpStatus).toBe(302)
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

  it('ignores a malformed usage instead of discarding a transcript the service produced', async () => {
    // `usage` is SpeechRail's own extension and no consumer reads it, so only `text` decides whether
    // an answer is usable. Refusing the whole response over a field nobody reads threw away a real
    // take and made the user dictate again; the malformed value is simply not read.
    const bodies = [
      '{"text":"kept","usage":{"type":"duration","seconds":-1}}',
      '{"text":"kept","usage":{}}',
      '{"text":"kept","usage":{"type":"duration"}}',
      '{"text":"kept","usage":{"type":"duration","seconds":"1"}}',
      '{"text":"kept","usage":{"type":"duration","seconds":1e999}}',
      '{"text":"kept","usage":{"type":"tokens","seconds":1}}',
      '{"text":"kept","usage":[]}',
      '{"text":"kept","usage":"duration"}',
    ]
    for (const body of bodies) {
      const server = await start((_request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(body)
      })
      const outcome = await transcribe({ baseUrl: server.baseUrl, model: '', language: null, credential: SECRET, audio: AUDIO, timeoutMs: 5_000 })
      expect(outcome.ok, body).toBe(true)
      if (!outcome.ok) throw new Error('unreachable')
      expect(outcome.text, body).toBe('kept')
    }
  })

  it('accepts a null usage exactly like an absent one', async () => {
    // `{"usage": null}` is what a JSON producer emits for "no value"; refusing it while
    // accepting an absent key would make the compatibility rule depend on the encoder.
    const server = await start((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"text":"ok","usage":null}')
    })
    const outcome = await transcribe({ baseUrl: server.baseUrl, model: '', language: null, credential: SECRET, audio: AUDIO, timeoutMs: 5_000 })
    expect(outcome.ok).toBe(true)
  })

  it('refuses a 200 that is not a JSON object carrying text', async () => {
    const bodies = ['<html>not json</html>', '[]', '"text"', '{"text":42}', '{"text":null}', '{}']
    for (const body of bodies) {
      const server = await start((_request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(body)
      })
      const outcome = await transcribe({ baseUrl: server.baseUrl, model: '', language: null, credential: SECRET, audio: AUDIO, timeoutMs: 5_000 })
      expect(outcome.ok, body).toBe(false)
      if (outcome.ok) throw new Error('unreachable')
      expect(outcome.failure.code, body).toBe('malformed-response')
    }
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
    expect(outcome.authenticated).toBe('refused')
    expect(outcome.failure?.code).toBe('unauthorized')
  })

  it('classifies a service without the capability endpoint as capabilities-absent', async () => {
    // An engine that only transcribes answers 404 here. It is usable, and the state the
    // caller must keep is "no snapshot", never "unreachable" or "credential refused".
    const server = await start((_request, response) => { response.writeHead(404); response.end() })
    const outcome = await probeCapabilities({ baseUrl: server.baseUrl, credential: SECRET, timeoutMs: 2_000 })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('unreachable')
    expect(outcome.reachable).toBe(true)
    expect(outcome.authenticated).toBe('unverified')
    expect(outcome.failure?.code).toBe('capabilities-absent')
    expect(outcome.failure?.httpStatus).toBe(404)
  })

  it('treats 405 on the capability endpoint as absent and keeps 501 a server error', async () => {
    // 501 is a 5xx: a gateway that cannot serve the route is not the same statement as an
    // engine that does not implement it, and it keeps its retryable hint.
    const gateway = await start((_request, response) => { response.writeHead(501); response.end() })
    const refused = await probeCapabilities({ baseUrl: gateway.baseUrl, credential: SECRET, timeoutMs: 2_000 })
    expect(refused.ok).toBe(false)
    if (refused.ok) throw new Error('unreachable')
    expect(refused.failure?.code).toBe('server-error')
    expect(refused.failure?.retryable).toBe(true)
    expect(refused.authenticated).toBe('unverified')

    for (const status of [405]) {
      const server = await start((_request, response) => { response.writeHead(status); response.end() })
      const outcome = await probeCapabilities({ baseUrl: server.baseUrl, credential: SECRET, timeoutMs: 2_000 })
      expect(outcome.ok).toBe(false)
      if (outcome.ok) throw new Error('unreachable')
      expect(outcome.failure?.code).toBe('capabilities-absent')
    }
  })

  it('classifies an absent capability endpoint from the status, not from its body', async () => {
    // A 404 whose body is over the cap (or stalls) still proves the endpoint is not there;
    // keying on the body's failure would report a missing endpoint as a malformed answer.
    const server = await start((_request, response) => {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(`{"error":"${'a'.repeat(300_000)}"}`)
    })
    const outcome = await probeCapabilities({ baseUrl: server.baseUrl, credential: SECRET, timeoutMs: 5_000 })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('unreachable')
    expect(outcome.reachable).toBe(true)
    expect(outcome.failure?.code).toBe('capabilities-absent')
    expect(outcome.failure?.httpStatus).toBe(404)
    expect(outcome.authenticated).toBe('unverified')
  })

  it('judges a 401 from its status even when its body is unusable', async () => {
    // Same 401, three body shapes: the verdict must not depend on what followed the status line.
    for (const shape of ['clean', 'oversized', 'stalled'] as const) {
      const server = await start((_request, response) => {
        response.writeHead(401, { 'content-type': 'application/json' })
        if (shape === 'clean') response.end('{"error":"bad key"}')
        else if (shape === 'oversized') response.end(`{"error":"${'a'.repeat(300_000)}"}`)
        else {
          // A head that reached the client, then a body that never arrives. `flushHeaders` is what
          // makes this the case under test; without it Node would hold the status line back and the
          // request really would be unproven.
          response.flushHeaders()
        }
      })
      const outcome = await probeCapabilities({ baseUrl: server.baseUrl, credential: SECRET, timeoutMs: 500 })
      expect(outcome.ok, shape).toBe(false)
      if (outcome.ok) throw new Error('unreachable')
      expect(outcome.authenticated, shape).toBe('refused')
      expect(outcome.reachable, shape).toBe(true)
    }
  })

  it('treats an unusable body on a 401 upload as a proven refusal', async () => {
    // The status head arrived before the body broke, so the service refused the request: the
    // outcome is proven and the gate must settle rather than demand an acknowledgement.
    for (const shape of ['oversized', 'stalled'] as const) {
      const server = await start((_request, response) => {
        response.writeHead(401, { 'content-type': 'application/json' })
        if (shape === 'oversized') response.end(`{"error":"${'a'.repeat(300_000)}"}`)
        else response.flushHeaders()
      })
      const outcome = await transcribe({ baseUrl: server.baseUrl, model: '', language: null, credential: SECRET, audio: AUDIO, timeoutMs: 500 })
      expect(outcome.ok, shape).toBe(false)
      if (outcome.ok) throw new Error('unreachable')
      expect(outcome.failure.code, shape).toBe('unauthorized')
      expect(outcome.failure.outcome, shape).toBe('failed')
      expect(outcome.failure.httpStatus, shape).toBe(401)
    }
  })

  it('keeps an unusable body on a 200 whose reply was never framed', async () => {
    // No Content-Length and no chunked encoding: the body ends when the socket does, so a reply cut
    // mid-transcript is indistinguishable from a complete one. The same unusable body on a framed
    // reply settles (the service proved it had finished); this one must not.
    const sockets = new Set<Socket>()
    const server = createSocketServer((socket) => {
      sockets.add(socket)
      socket.on('close', () => { sockets.delete(socket) })
      socket.on('data', () => { /* swallow the upload */ })
      socket.end('HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n{"text":"hel')
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    try {
      const port = (server.address() as AddressInfo).port
      const outcome = await transcribe({ baseUrl: `http://127.0.0.1:${port}/v1`, model: '', language: null, credential: SECRET, audio: AUDIO, timeoutMs: 5_000 })
      expect(outcome.ok).toBe(false)
      if (outcome.ok) throw new Error('unreachable')
      expect(outcome.failure.code).toBe('malformed-response')
      expect(outcome.failure.outcome).toBe('unknown')
    } finally {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    }
  })

  it('fails closed when the transfer-encoding carries a tab Node did not de-chunk', async () => {
    // A tab is legal optional whitespace, and Node *reports* the value trimmed while deciding framing
    // on the untrimmed bytes: `chunked\t` arrives close-delimited but reads as chunked. Treating it as
    // framed settles an unproven outcome - and this one clears the journal and opens the gate.
    for (const spelling of ['chunked\t', 'chunked\t ', 'chunked \t']) {
      const sockets = new Set<Socket>()
      const server = createSocketServer((socket) => {
        sockets.add(socket)
        socket.on('close', () => { sockets.delete(socket) })
        socket.on('data', () => { /* swallow the upload */ })
        socket.end(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ntransfer-encoding: ${spelling}\r\n\r\n{"detail":"nope"}`)
      })
      await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
      try {
        const port = (server.address() as AddressInfo).port
        const outcome = await transcribe({ baseUrl: `http://127.0.0.1:${port}/v1`, model: '', language: null, credential: SECRET, audio: AUDIO, timeoutMs: 5_000 })
        expect(outcome.ok, spelling).toBe(false)
        if (outcome.ok) throw new Error('unreachable')
        expect(outcome.failure.code, spelling).toBe('malformed-response')
        expect(outcome.failure.outcome, spelling).toBe('unknown')
      } finally {
        for (const socket of sockets) socket.destroy()
        await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
      }
    }
  })

  it('does not let a transfer-encoding that merely contains "chunked" claim framing', async () => {
    // `notchunked`, `xchunked` and `chunked-fake` are not chunked: Node does not de-chunk them, so the
    // body still ends at the close. A substring test would settle an outcome the service never
    // confirmed.
    const sockets = new Set<Socket>()
    const server = createSocketServer((socket) => {
      sockets.add(socket)
      socket.on('close', () => { sockets.delete(socket) })
      socket.on('data', () => { /* swallow the upload */ })
      socket.end('HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ntransfer-encoding: notchunked\r\n\r\n{"detail":"nope"}')
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    try {
      const port = (server.address() as AddressInfo).port
      const outcome = await transcribe({ baseUrl: `http://127.0.0.1:${port}/v1`, model: '', language: null, credential: SECRET, audio: AUDIO, timeoutMs: 5_000 })
      expect(outcome.ok).toBe(false)
      if (outcome.ok) throw new Error('unreachable')
      expect(outcome.failure.code).toBe('malformed-response')
      expect(outcome.failure.outcome).toBe('unknown')
    } finally {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    }
  })

  it('keeps a chunked reply unproven, because its framing cannot be proven', async () => {
    // The body really is chunked-framed here (`gzip, chunked` plus a terminator), but Node reports the
    // header value trimmed while deciding framing on the raw bytes: a legal `chunked\t` arrives
    // close-delimited and reports the identical string, so no value test separates them. Believing a
    // merely stated framing would settle this unusable body and clear the journal, so the reply stays
    // unproven instead - the price of the conservative rule, recorded as a trade-off.
    const body = '{"detail":"nope"}'
    const sockets = new Set<Socket>()
    const server = createSocketServer((socket) => {
      sockets.add(socket)
      socket.on('close', () => { sockets.delete(socket) })
      socket.on('data', () => { /* swallow the upload */ })
      socket.end(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ntransfer-encoding: gzip, chunked\r\n\r\n${body.length.toString(16)}\r\n${body}\r\n0\r\n\r\n`)
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    try {
      const port = (server.address() as AddressInfo).port
      const outcome = await transcribe({ baseUrl: `http://127.0.0.1:${port}/v1`, model: '', language: null, credential: SECRET, audio: AUDIO, timeoutMs: 5_000 })
      expect(outcome.ok).toBe(false)
      if (outcome.ok) throw new Error('unreachable')
      expect(outcome.failure.code).toBe('malformed-response')
      expect(outcome.failure.outcome).toBe('unknown')
    } finally {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    }
  })

  it('reports the refusal a service sent while the body was still being written', async () => {
    // A service may check the authorization header and answer without waiting for a body it is still
    // receiving, then drop the connection. The status arrived, so `unreachable` would be false here:
    // a large enough body reproduces it on loopback, which is why the rule is tested rather than
    // argued. The probe judges the same server as a refused credential, so the two faces must agree.
    const sockets = new Set<Socket>()
    const server = createSocketServer((socket) => {
      sockets.add(socket)
      socket.on('close', () => { sockets.delete(socket) })
      socket.on('data', () => { /* swallow the upload */ })
      // Destroy only after the head reached the kernel, or the client never sees the status and the
      // case under test (a status that arrived while the body was still being written) is not built.
      // FIN rather than RST: a reset can discard the head before the client parses it, and then the
      // case under test (a status that arrived while the body was still being written) is not built.
      socket.end('HTTP/1.1 401 Unauthorized\r\ncontent-length: 64\r\n\r\n')
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    try {
      const port = (server.address() as AddressInfo).port
      const outcome = await performRequest({
        url: `http://127.0.0.1:${port}/v1/audio/transcriptions`,
        method: 'POST',
        headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'audio/wav' },
        body: Buffer.alloc(4 * 1024 * 1024, 0x41),
        timeoutMs: 5_000,
        maxResponseBytes: 262_144,
      })
      expect(outcome.ok).toBe(false)
      if (outcome.ok) throw new Error('unreachable')
      expect(outcome.failure.code).toBe('unauthorized')
      expect(outcome.failure.httpStatus).toBe(401)

      const probe = await probeCapabilities({ baseUrl: `http://127.0.0.1:${port}/v1`, credential: SECRET, timeoutMs: 5_000 })
      expect(probe.ok).toBe(false)
      if (probe.ok) throw new Error('unreachable')
      expect(probe.authenticated).toBe('refused')
      expect(probe.reachable).toBe(true)
    } finally {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    }
  })

  it('keeps a body that overran the response cap unproven', async () => {
    // This reply is framed, but it is larger than any answer this client will read, so it is refused
    // on size before its shape is judged: over the cap nothing proves the service finished, and the
    // body is never silently truncated into a partial transcript. (The framing rule itself is pinned
    // by the two tests above.)
    const server = await start((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(`{"text":"${'a'.repeat(300_000)}"}`)
    })
    const outcome = await transcribe({ baseUrl: server.baseUrl, model: '', language: null, credential: SECRET, audio: AUDIO, timeoutMs: 2_000 })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('unreachable')
    expect(outcome.failure.outcome).toBe('unknown')
  })

  it('settles a length-framed 200 whose body is unusable', async () => {
    // The other half of the framing rule: a reply that states its own length proves the service
    // finished, so an unusable body is a failed transcription rather than an unknown one.
    const server = await start((_request, response) => {
      const body = '{"detail":"nope"}'
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
      response.end(body)
    })
    const outcome = await transcribe({ baseUrl: server.baseUrl, model: '', language: null, credential: SECRET, audio: AUDIO, timeoutMs: 2_000 })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('unreachable')
    expect(outcome.failure.code).toBe('malformed-response')
    expect(outcome.failure.outcome).toBe('failed')
  })

  it('settles a framed 200 whose length is explicit', async () => {
    // Coverage for the Content-Length half of the framing test: dropping that clause used to leave
    // the whole host suite green.
    const body = '{"detail":"nope"}'
    const sockets = new Set<Socket>()
    const server = createSocketServer((socket) => {
      sockets.add(socket)
      socket.on('close', () => { sockets.delete(socket) })
      socket.on('data', () => { /* swallow the upload */ })
      socket.end(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${String(Buffer.byteLength(body))}\r\n\r\n${body}`)
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    try {
      const port = (server.address() as AddressInfo).port
      const outcome = await transcribe({ baseUrl: `http://127.0.0.1:${port}/v1`, model: '', language: null, credential: SECRET, audio: AUDIO, timeoutMs: 5_000 })
      expect(outcome.ok).toBe(false)
      if (outcome.ok) throw new Error('unreachable')
      expect(outcome.failure.code).toBe('malformed-response')
      expect(outcome.failure.outcome).toBe('failed')
    } finally {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    }
  })

  it('keeps a chunked 200 with an unusable body unproven', async () => {
    // A server that sets no length frames this reply with chunks, and the body really is complete -
    // but that completeness is not provable from what Node reports (see the decorated-chunked case),
    // so the outcome stays unproven and the gate stays closed until it is acknowledged.
    const server = await start((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"detail":"nope"}')
    })
    const outcome = await transcribe({ baseUrl: server.baseUrl, model: '', language: null, credential: SECRET, audio: AUDIO, timeoutMs: 2_000 })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('unreachable')
    expect(outcome.failure.code).toBe('malformed-response')
    expect(outcome.failure.outcome).toBe('unknown')
  })

  it('keeps a transfer-encoding that is not chunked unframed', async () => {
    // `identity` is a transfer-encoding token but not framing: Node does not de-chunk it, so the body
    // still ends at the close and truncation stays indistinguishable from completion.
    const sockets = new Set<Socket>()
    const server = createSocketServer((socket) => {
      sockets.add(socket)
      socket.on('close', () => { sockets.delete(socket) })
      socket.on('data', () => { /* swallow the upload */ })
      socket.end('HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ntransfer-encoding: identity\r\n\r\n{"detail":"nope"}')
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    try {
      const port = (server.address() as AddressInfo).port
      const outcome = await transcribe({ baseUrl: `http://127.0.0.1:${port}/v1`, model: '', language: null, credential: SECRET, audio: AUDIO, timeoutMs: 5_000 })
      expect(outcome.ok).toBe(false)
      if (outcome.ok) throw new Error('unreachable')
      expect(outcome.failure.code).toBe('malformed-response')
      expect(outcome.failure.outcome).toBe('unknown')
    } finally {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    }
  })

  it('reports a server that never answered as unverified', async () => {
    const outcome = await probeCapabilities({ baseUrl: 'http://127.0.0.1:1/v1', credential: SECRET, timeoutMs: 1_000 })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('unreachable')
    expect(outcome.reachable).toBe(false)
    expect(outcome.authenticated).toBe('unverified')
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

  it('does not call a service error an accepted credential', async () => {
    // Only a 200 proves the credential was accepted; a 500 says nothing about it, and
    // reporting acceptance here turned any server error into "authorized".
    const server = await start((_request, response) => {
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'boom', code: 'server_error' } }))
    })
    const outcome = await probeCapabilities({ baseUrl: server.baseUrl, credential: SECRET, timeoutMs: 1_000 })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('unreachable')
    expect(outcome.reachable).toBe(true)
    expect(outcome.authenticated).toBe('unverified')
    expect(outcome.failure?.code).toBe('server-error')
  })

  it('settles when the service upgrades the connection instead of answering', async () => {
    // A 101 is neither `information` nor `response`, and after it destroy() settles nothing:
    // the probe used to hang past its deadline and hold the gate busy forever.
    //
    // The raw socket is deliberately held open (that is the stall under test), so the peer
    // sits in CLOSE_WAIT until the cleanup below destroys it; fd counts return to baseline
    // there, which is why this pattern leaves nothing behind in the suite.
    const sockets = new Set<Socket>()
    const server = createSocketServer((socket) => {
      sockets.add(socket)
      socket.on('close', () => { sockets.delete(socket) })
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    try {
      const port = (server.address() as AddressInfo).port
      const started = Date.now()
      const outcome = await probeCapabilities({ baseUrl: `http://127.0.0.1:${String(port)}/v1`, credential: SECRET, timeoutMs: 30_000 })
      expect(Date.now() - started).toBeLessThan(5_000)
      expect(outcome.ok).toBe(false)
      if (outcome.ok) throw new Error('unreachable')
      expect(outcome.failure?.code).toBe('unreachable')
      expect(outcome.reachable).toBe(true)
    } finally {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    }
  })

  it('counts an informational response as an answer too', async () => {
    // Node reports 1xx on its own event; a 103 followed by a stall still proves the
    // service is there. As above, the stall is the point and the socket is destroyed in
    // the cleanup rather than by the server.
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
