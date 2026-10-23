/**
 * The thin agent entry point.
 *
 * Read-only by construction: the tool maps the Host service's own status, never
 * touches the network unless asked, and cannot carry a credential or a transcript.
 */

import { describe, expect, it } from 'vitest'
import { STATUS_TOOL_NAME, describeStatus, createStatusTool, type StatusToolSource, type StatusToolValue } from '../src/host/tools.ts'
import type { SpeechRailCheckResult, SpeechRailInputStatus } from '../src/types.ts'

const STATUS: SpeechRailInputStatus = {
  baseUrl: 'http://127.0.0.1:8201/v1',
  endpointProblem: null,
  model: 'asr-1.7b-q8',
  credentialRef: 'SPEECHRAIL_API_KEY',
  credentialConfigured: true,
  language: 'zh',
  languageOptions: ['auto', 'zh', 'en'],
  requestTimeoutMs: 150_000,
  limits: { maxUploadBytes: 1_048_576, maxAudioSeconds: 30 },
  gate: 'ready',
  pendingOperationId: null,
  capabilities: null,
  checkedAt: null,
  revision: 4,
}

const CHECK: SpeechRailCheckResult = {
  reachable: true,
  authenticated: true,
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
    expect(names).toHaveLength(12)
    expect([...schema.required].sort()).toEqual([...names].sort())
    for (const [name, property] of Object.entries(schema.properties)) {
      // Requiredness belongs to the top-level array only. A per-property `required`
      // is rejected by the registry's assertSupportedJsonSchema, which is exactly how
      // this tool was dead on arrival once; re-verify against the real registry with
      // `node tools/check-tool-schema.mjs`.
      expect(property, name).not.toHaveProperty('required')
    }
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
      gate: 'ready',
      pendingOperationId: '',
      maxUploadBytes: 1_048_576,
      maxAudioSeconds: 30,
      probed: false,
      reachable: false,
      authenticated: false,
    })
  })

  it('probes the service only when asked, and then reports the fresh result', async () => {
    const { stub, calls } = source()
    const value = await createStatusTool(stub).execute({ probe: true }) as StatusToolValue
    expect(calls).toEqual({ status: 1, check: 1 })
    expect(value.probed).toBe(true)
    expect(value.reachable).toBe(true)
    expect(value.authenticated).toBe(true)
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
      gate: 'ready',
      pendingOperationId: '',
      maxUploadBytes: 4_194_304,
      maxAudioSeconds: 120,
      probed: true,
      reachable: false,
      authenticated: false,
    }
    expect(describeStatus(base)).toContain('service unreachable')
    expect(describeStatus({ ...base, probed: false })).toContain('service not probed')
    expect(describeStatus({ ...base, endpoint: '', endpointProblem: 'not loopback' })).toContain('endpoint refused: not loopback')
  })
})
