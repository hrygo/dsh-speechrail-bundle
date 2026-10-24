/**
 * The thin agent entry point.
 *
 * Read-only by construction: the tool maps the Host service's own status, never
 * touches the network unless asked, and cannot carry a credential or a transcript.
 */

import { describe, expect, it, vi } from 'vitest'
import { STATUS_TOOL_NAME, describeStatus, createStatusTool, type StatusToolSource, type StatusToolValue } from '../src/host/tools.ts'
import { encodeWave } from '../src/protocol/wave.ts'
import { failure } from '../src/host/failure.ts'
import { SpeechRailInputCore } from '../src/host/core.ts'
import { memoryJournal } from '../src/host/journal.ts'
import type { SpeechRailCheckResult, SpeechRailFailure, SpeechRailInputStatus } from '../src/types.ts'

const STATUS: SpeechRailInputStatus = {
  baseUrl: 'http://127.0.0.1:8201/v1',
  endpointProblem: null,
  model: 'asr-1.7b-q8',
  credentialRef: 'SPEECHRAIL_API_KEY',
  credentialConfigured: true,
  language: 'zh',
  languageHint: '' as const,
  transcriptionSupport: 'unknown' as const,
  languageOptions: ['auto', 'zh', 'en'],
  requestTimeoutMs: 150_000,
  limits: { maxUploadBytes: 1_048_576, maxAudioSeconds: 30 },
  gate: 'ready',
  pendingOperationId: null,
    unprovenFailure: null,
  capabilities: null,
  checkedAt: null,
  revision: 4,
}

const CHECK: SpeechRailCheckResult = {
  reachable: true,
  authenticated: 'accepted',
  capabilities: null,
  failure: null,
  checkedAt: '2026-10-23T12:00:00.000Z',
}

function source(overrides: Partial<SpeechRailInputStatus> = {}): { stub: StatusToolSource, calls: { status: number, check: number } } {
  const calls = { status: 0, check: 0 }
  return {
    calls,
    stub: {
      async status() { calls.status += 1; return { ...STATUS, ...overrides } },
      async check() { calls.check += 1; return CHECK },
    },
  }
}

describe('speechrail_input_status', () => {
  it('declares the parameter contract and every registry schema invariant', () => {
    const tool = createStatusTool(source().stub)
    expect(tool.name).toBe(STATUS_TOOL_NAME)
    expect(tool.description).toContain('voice input is usable')

    const parameters = tool.parameters as { properties: Record<string, { type?: string }>, required?: readonly string[], type: string }
    expect(parameters.type).toBe('object')
    expect(parameters.properties.probe?.type).toBe('boolean')
    // An optional property carries no `required` annotation at the root.
    expect(parameters.required).toBeUndefined()

    const schema = tool.output.schema as {
      type: string
      additionalProperties: boolean
      properties: Record<string, { type?: string, required?: unknown }>
      required: readonly string[]
    }
    expect(schema.type).toBe('object')
    expect(schema.additionalProperties).toBe(false)
    const names = Object.keys(schema.properties)
    expect(names).toHaveLength(18)
    expect([...schema.required].sort()).toEqual([...names].sort())
    for (const [name, property] of Object.entries(schema.properties)) {
      // Requiredness belongs to the top-level array only. A per-property `required`
      // is rejected by the registry's assertSupportedJsonSchema, which is exactly how
      // this tool was dead on arrival once; re-verify against the real registry with
      // `node tools/check-tool-schema.mjs`.
      expect(property, name).not.toHaveProperty('required')
    }
    // The credential field carries the three-value vocabulary, not a boolean.
    expect(schema.properties.authenticated).toMatchObject({
      type: 'string',
      enum: ['accepted', 'refused', 'unverified'],
    })
  })

  it('calls a service without capabilities a plain transcription endpoint', async () => {
    const { stub } = source()
    const withoutCapabilities: StatusToolSource = {
      ...stub,
      check: async () => ({
        ...CHECK,
        reachable: true,
        authenticated: 'unverified',
        capabilities: null,
        failure: failure('capabilities-absent', { httpStatus: 404 }),
      }),
    }
    const value = await createStatusTool(withoutCapabilities).execute({ probe: true }) as StatusToolValue
    expect(value.failureCode).toBe('capabilities-absent')
    const text = describeStatus(value)
    expect(text).toContain('plain transcription endpoint')
    expect(text).not.toContain('not accepting the request')
  })

  it('reports the cached state without touching the network by default', async () => {
    const { stub, calls } = source()
    const value = await createStatusTool(stub).execute({}) as StatusToolValue
    expect(calls).toEqual({ status: 1, check: 0 })
    expect(value).toEqual({
      credentialConfigured: true,
      endpoint: 'http://127.0.0.1:8201/v1',
      endpointProblem: '',
      model: 'asr-1.7b-q8',
      language: 'zh',
      // The stub's fixture stands in for a host that has no snapshot in force: it reports the
      // language that was configured, no hint that would travel, and no statement about support.
      languageHint: '',
      transcriptionSupport: 'unknown',
      languageOptions: ['auto', 'zh', 'en'],
      gate: 'ready',
      pendingOperationId: '',
      maxUploadBytes: 1_048_576,
      maxAudioSeconds: 30,
      probed: false,
      reachable: false,
      authenticated: 'unverified',
      failureCode: '',
      unprovenFailureCode: '',
      unprovenFailureHttpStatus: 0,
    })
  })

  it('probes the service only when asked, and then reports the fresh result', async () => {
    const { stub, calls } = source()
    const value = await createStatusTool(stub).execute({ probe: true }) as StatusToolValue
    expect(calls).toEqual({ status: 1, check: 1 })
    expect(value.probed).toBe(true)
    expect(value.reachable).toBe(true)
    expect(value.authenticated).toBe('accepted')
  })

  it('surfaces a refused endpoint, a missing credential and a blocked gate as data', async () => {
    const { stub } = source({
      baseUrl: '',
      endpointProblem: 'the endpoint must be a loopback address',
      credentialConfigured: false,
      gate: 'unknown',
      pendingOperationId: 'op_aaaaaaaa',
    })
    const value = await createStatusTool(stub).execute({}) as StatusToolValue
    expect(value.endpoint).toBe('')
    expect(value.endpointProblem).toBe('the endpoint must be a loopback address')
    expect(value.credentialConfigured).toBe(false)
    expect(value.gate).toBe('unknown')
    expect(value.pendingOperationId).toBe('op_aaaaaaaa')
    // Nothing sensitive can appear: the canonical value has no free-text carrier.
    expect(JSON.stringify(value)).not.toContain('SPEECHRAIL_API_KEY')
  })

  it('does not report a service as unreachable when no request was ever made', async () => {
    const { stub } = source({ credentialConfigured: false })
    const neverAsked: StatusToolSource = {
      ...stub,
      check: async () => ({ ...CHECK, reachable: false, authenticated: 'unverified', failure: failure('not-configured') }),
    }
    const tool = createStatusTool(neverAsked)
    const value = await tool.execute({ probe: true }) as StatusToolValue

    expect(value.probed).toBe(false)
    const [block] = tool.output.render({ probe: true }, value)
    const text = (block as { text: string }).text
    expect(text).toContain('service not probed')
    expect(text).not.toContain('service unreachable')
  })

  it('treats a refused endpoint as "not probed" as well', async () => {
    const { stub } = source({ baseUrl: '', endpointProblem: 'the endpoint must be a loopback address' })
    const refused: StatusToolSource = {
      ...stub,
      check: async () => ({ ...CHECK, reachable: false, authenticated: 'unverified', failure: failure('endpoint-invalid') }),
    }
    const value = await createStatusTool(refused).execute({ probe: true }) as StatusToolValue
    expect(value.probed).toBe(false)
  })

  it('reports "not probed" through the real core when no credential is configured', async () => {
    // The integration case behind the live profile: the host short-circuits before any
    // exchange, so the tool must not claim the service was unreachable.
    const probe = vi.fn(async () => { throw new Error('the service must not be contacted') })
    const core = new SpeechRailInputCore({
      now: () => new Date('2026-10-23T12:00:00.000Z'),
      config: () => ({ baseUrl: 'http://127.0.0.1:8201/v1', endpointRefusal: null, credentialRef: 'SPEECHRAIL_API_KEY', model: '', language: 'auto', requestTimeoutMs: 150_000 }),
      resolveCredential: async () => null,
      journal: memoryJournal(),
      transcribe: async () => ({ ok: false, failure: failure('internal') }),
      probe,
      settingsRevision: () => 1,
      writeSettings: async () => 'ok',
    })
    const tool = createStatusTool(core)
    const value = await tool.execute({ probe: true }) as StatusToolValue
    const [block] = tool.output.render({ probe: true }, value)
    expect(probe).not.toHaveBeenCalled()
    expect(value.probed).toBe(false)
    expect((block as { text: string }).text).not.toContain('service unreachable')
  })

  it('renders one bounded line naming the blocking facts', async () => {
    const { stub } = source({ gate: 'unknown', pendingOperationId: 'op_bbbbbbbb' })
    const tool = createStatusTool(stub)
    const value = await tool.execute({ probe: true }) as StatusToolValue
    const content = tool.output.render({ probe: true }, value)
    expect(content).toHaveLength(1)
    const [block] = content
    expect(block?.type).toBe('text')
    const text = (block as { text: string }).text
    expect(text).toContain('service reachable and authorized')
    expect(text).toContain('gate unknown')
    expect(text).toContain('op_bbbbbbbb')
    expect(text).toContain('1048576 bytes / 30s')
  })

  it('describes an unreachable and unprobed service distinctly', () => {
    const base: StatusToolValue = {
      credentialConfigured: false,
      endpoint: 'http://127.0.0.1:8201/v1',
      endpointProblem: '',
      model: '',
      language: 'auto',
      languageHint: '',
      transcriptionSupport: 'unknown',
      languageOptions: ['auto'],
      gate: 'ready',
      pendingOperationId: '',
      maxUploadBytes: 4_194_304,
      maxAudioSeconds: 120,
      probed: true,
      reachable: false,
      authenticated: 'unverified',
      failureCode: 'unreachable',
      unprovenFailureCode: '',
      unprovenFailureHttpStatus: 0,
    }
    expect(describeStatus(base)).toContain('service unreachable')
    expect(describeStatus({ ...base, probed: false })).toContain('service not probed')
    expect(describeStatus({ ...base, endpoint: '', endpointProblem: 'not loopback' })).toContain('endpoint refused: not loopback')
  })

  it('names the cause of a closed gate in the rendered report', () => {
    // The gate line says what to do; without the cause the reader has to guess what the service did.
    const base: StatusToolValue = {
      credentialConfigured: true,
      endpoint: 'http://127.0.0.1:8201/v1',
      endpointProblem: '',
      model: '',
      language: 'auto',
      languageHint: '',
      languageOptions: [],
      transcriptionSupport: 'unknown',
      gate: 'unknown',
      pendingOperationId: 'op_llllllll',
      maxUploadBytes: 4_194_304,
      maxAudioSeconds: 120,
      probed: false,
      reachable: false,
      authenticated: 'unverified',
      failureCode: '',
      unprovenFailureCode: 'server-error',
      unprovenFailureHttpStatus: 502,
    }
    expect(describeStatus(base)).toContain('that attempt failed with server-error (HTTP 502)')
    // A failure that never got an answer says so instead of inventing a status.
    expect(describeStatus({ ...base, unprovenFailureCode: 'timeout', unprovenFailureHttpStatus: 0 }))
      .toContain('that attempt failed with timeout before a response arrived')
    // Nothing is claimed when the status carries no cause: an open gate reports none, and neither does
    // a gate reopened on an operation whose own failure the host does not know.
    expect(describeStatus({ ...base, unprovenFailureCode: '', unprovenFailureHttpStatus: 0 }))
      .not.toContain('that attempt failed')
  })

  it('never shows a cause beside an open gate, and names local storage when it is the cause', () => {
    // Both are renderer-level guards: the status already reports a cause only for the operation holding
    // the gate, and a hand-built value must not be able to contradict that.
    const base: StatusToolValue = {
      credentialConfigured: true,
      endpoint: 'http://127.0.0.1:8201/v1',
      endpointProblem: '',
      model: '',
      language: 'auto',
      languageHint: '',
      languageOptions: [],
      transcriptionSupport: 'unknown',
      gate: 'ready',
      pendingOperationId: '',
      maxUploadBytes: 4_194_304,
      maxAudioSeconds: 120,
      probed: false,
      reachable: false,
      authenticated: 'unverified',
      failureCode: '',
      unprovenFailureCode: 'timeout',
      unprovenFailureHttpStatus: 0,
    }
    expect(describeStatus(base)).not.toContain('that attempt failed')

    // A closed gate with no operation is what an unreadable journal produces.
    const unreadable = { ...base, gate: 'unknown' as const, unprovenFailureCode: '', unprovenFailureHttpStatus: 0 }
    expect(describeStatus(unreadable)).toContain('the local journal could not be read')
    expect(describeStatus({ ...unreadable, pendingOperationId: 'op_aaaaaaaa' }))
      .not.toContain('the local journal could not be read')
  })

  it('does not call a live upload an awaited acknowledgement', () => {
    // A busy gate holds an operation id too. Calling it "awaiting acknowledgement" would tell the
    // reader to clear an upload that is still in flight.
    const busy: StatusToolValue = {
      credentialConfigured: true,
      endpoint: 'http://127.0.0.1:8201/v1',
      endpointProblem: '',
      model: '',
      language: 'auto',
      languageHint: '',
      languageOptions: [],
      transcriptionSupport: 'unknown',
      gate: 'busy',
      pendingOperationId: 'op_llllllll',
      maxUploadBytes: 4_194_304,
      maxAudioSeconds: 120,
      probed: false,
      reachable: false,
      authenticated: 'unverified',
      failureCode: '',
      unprovenFailureCode: '',
      unprovenFailureHttpStatus: 0,
    }
    expect(describeStatus(busy)).toContain('gate busy')
    expect(describeStatus(busy)).not.toContain('awaiting acknowledgement')
  })

  it('separates a refused credential from another reachable failure', () => {
    // A 401 says the credential is wrong; a 500 only says the service answered badly, and
    // calling that "authorized" or "rejecting the credential" would both be false.
    const base: StatusToolValue = {
      credentialConfigured: true,
      endpoint: 'http://127.0.0.1:8201/v1',
      endpointProblem: '',
      model: '',
      language: 'auto',
      languageHint: '',
      transcriptionSupport: 'unknown',
      languageOptions: ['auto'],
      gate: 'ready',
      pendingOperationId: '',
      maxUploadBytes: 4_194_304,
      maxAudioSeconds: 120,
      probed: true,
      reachable: true,
      authenticated: 'refused',
      failureCode: 'unauthorized',
      unprovenFailureCode: '',
      unprovenFailureHttpStatus: 0,
    }
    expect(describeStatus(base)).toContain('rejecting the credential')
    const failed = describeStatus({ ...base, authenticated: 'unverified', failureCode: 'server-error' })
    expect(failed).toContain('not accepting the request')
    expect(failed).not.toContain('authorized')
    expect(failed).not.toContain('rejecting the credential')
  })
})

describe('SpeechRail status tool over a real core', () => {
  it('carries the gate cause from the status into both flat fields', async () => {
    // The mapping matters and was only ever hand-built before: a value with a hardwired '' would have
    // passed the whole suite while the agent saw no cause at all.
    const unknownFailure: SpeechRailFailure = {
      code: 'server-error', httpStatus: 502, retryable: true, requestId: 'req_1', outcome: 'unknown',
    }
    const core = new SpeechRailInputCore({
      now: () => new Date('2026-10-23T12:00:00.000Z'),
      config: () => ({ baseUrl: 'http://127.0.0.1:8201/v1', endpointRefusal: null, credentialRef: 'SPEECHRAIL_API_KEY', model: '', language: 'auto', requestTimeoutMs: 150_000 }),
      resolveCredential: async () => 'secret',
      journal: memoryJournal(),
      transcribe: async () => ({ ok: false, failure: unknownFailure }),
      probe: async () => ({ ok: true, capabilities: null }),
      settingsRevision: () => 1,
      writeSettings: async () => 'ok',
    })
    const tool = createStatusTool(core)
    const audioBase64 = Buffer.from(encodeWave(new Float32Array(1_600))).toString('base64')
    const result = await core.transcribe(JSON.stringify({ operationId: 'op_aaaaaaaa', audioBase64 }))
    expect(result.ok).toBe(false)

    const value = await tool.execute({}) as StatusToolValue
    expect(value.gate).toBe('unknown')
    expect(value.pendingOperationId).toBe('op_aaaaaaaa')
    expect(value.unprovenFailureCode).toBe('server-error')
    expect(value.unprovenFailureHttpStatus).toBe(502)
    expect(describeStatus(value)).toContain('that attempt failed with server-error (HTTP 502)')

    // An attempt that settles (a refusal the service answered) records nothing: the gate stays open.
    const settled = new SpeechRailInputCore({
      now: () => new Date('2026-10-23T12:00:00.000Z'),
      config: () => ({ baseUrl: 'http://127.0.0.1:8201/v1', endpointRefusal: null, credentialRef: 'SPEECHRAIL_API_KEY', model: '', language: 'auto', requestTimeoutMs: 150_000 }),
      resolveCredential: async () => 'secret',
      journal: memoryJournal(),
      transcribe: async () => ({ ok: false, failure: failure('unauthorized') }),
      probe: async () => ({ ok: true, capabilities: null }),
      settingsRevision: () => 1,
      writeSettings: async () => 'ok',
    })
    const settledTool = createStatusTool(settled)
    await settled.transcribe(JSON.stringify({ operationId: 'op_bbbbbbbb', audioBase64 }))
    const settledValue = await settledTool.execute({}) as StatusToolValue
    expect(settledValue.gate).toBe('ready')
    expect(settledValue.unprovenFailureCode).toBe('')
    expect(settledValue.unprovenFailureHttpStatus).toBe(0)
  })
})
