/**
 * The Remote boundary the client actually calls.
 *
 * The design review requires strict input refusal to be proven through the real
 * generated Remote entry rather than only through direct Host calls. The entry
 * transports each request as a bounded JSON *string* carrier, so this test drives
 * the generated contribution's own metadata and then feeds the very string it would
 * carry into the Host parser.
 */

import { describe, expect, it } from 'vitest'
import contribution from '../lib/typert.remote-client.js'
import { parseAcknowledgeRequest, parseConfigureRequest, parseTranscribeRequest } from '../src/host/core.ts'
import { REMOTE_NAMESPACE } from '../src/contracts.ts'
import type { SpeechRailAuthentication, SpeechRailCheckResult } from '../src/types.ts'

/** Method ids the generated contribution must declare. */
const METHODS = [
  `${REMOTE_NAMESPACE}/status`,
  `${REMOTE_NAMESPACE}/check`,
  `${REMOTE_NAMESPACE}/configure`,
  `${REMOTE_NAMESPACE}/transcribe`,
  `${REMOTE_NAMESPACE}/acknowledgeUnknown`,
] as const

describe('generated Remote contribution', () => {
  it('declares exactly the five endpoints this bundle publishes', () => {
    expect(contribution.package).toBe('dsh-voice-input')
    expect(Object.keys(contribution.methods).sort()).toEqual([...METHODS].sort())
  })

  it('takes no parameter for the two read endpoints', () => {
    for (const method of ['status', 'check']) {
      const descriptor = contribution.methods[`${REMOTE_NAMESPACE}/${method}`]
      expect(descriptor.id.endsWith(`${REMOTE_NAMESPACE}/${method}`)).toBe(true)
      expect(descriptor.namespace).toBe(REMOTE_NAMESPACE)
      expect(descriptor.parameters).toHaveLength(0)
    }
  })

  it('carries every mutating request as one strict string parameter', () => {
    for (const method of ['configure', 'transcribe', 'acknowledgeUnknown']) {
      const descriptor = contribution.methods[`${REMOTE_NAMESPACE}/${method}`]
      expect(descriptor.parameters).toHaveLength(1)
      const [parameter] = descriptor.parameters
      expect(parameter?.name).toBe('payload')
      expect(parameter?.source).toBe('json')
      expect(parameter?.codec.mode).toBe('strict')
      expect(parameter?.codec.jsonSchema).toEqual({ type: 'string' })
    }
  })

  it('declares cancellation on the transcript call only', () => {
    expect(contribution.methods[`${REMOTE_NAMESPACE}/transcribe`].cancellation).toEqual({ parameter: 'signal' })
    expect(contribution.methods[`${REMOTE_NAMESPACE}/status`].cancellation).toBeUndefined()
  })

  it('takes its boundary types from the public type subpath', () => {
    for (const id of METHODS) {
      const symbol = contribution.methods[id].result.typeSymbol
      expect(symbol.startsWith('dsh-voice-input/types#')).toBe(true)
    }
  })

  it('carries the credential verdict as one of three strings, never a boolean', () => {
    // The published type is the contract other packages read; a boolean here would let a
    // consumer keep conflating "refused" with "nothing judged it".
    const verdicts: SpeechRailAuthentication[] = ['accepted', 'refused', 'unverified']
    const result: SpeechRailCheckResult = {
      reachable: true, authenticated: verdicts[1] ?? 'unverified', capabilities: null, failure: null, checkedAt: '2026-10-23T12:00:00.000Z',
    }
    expect(verdicts).toHaveLength(3)
    expect(result.authenticated).toBe('refused')
  })

  it('carries the effective hint and the transcription fact across the boundary', () => {
    // The page renders `languageHint` and reads the tri-state fact, so a stale generation would
    // silently blank both rather than fail. The two facts that nearly share a name are asserted
    // apart: the capability view keeps the service's own boolean, the status carries what is known.
    interface StatusManifest {
      readonly result: { readonly spec: { readonly jsonSchema: {
        readonly properties: Record<string, { readonly type?: string, readonly enum?: readonly string[] }>
        readonly required: readonly string[]
      } } }
    }
    const manifest = (contribution.methods as unknown as Record<string, StatusManifest | undefined>)['speechrailInput/status']
    if (manifest === undefined) throw new Error('the status method is part of the contribution')
    const schema = manifest.result.spec.jsonSchema
    // The exact set, not only its size: a count cannot say which field was renamed, added or lost.
    expect(Object.keys(schema.properties).sort()).toEqual([
      'baseUrl', 'capabilities', 'checkedAt', 'credentialConfigured', 'credentialRef', 'endpointProblem',
      'gate', 'language', 'languageHint', 'languageOptions', 'limits', 'model', 'pendingOperationId',
      'requestTimeoutMs', 'revision', 'transcriptionSupport', 'unprovenFailure',
    ])
    // The cause of a closed gate has to cross the boundary, not stay host-side.
    expect(schema.required).toContain('unprovenFailure')
    expect(schema.required).toContain('languageHint')
    expect(schema.required).toContain('transcriptionSupport')
    expect(schema.required).toContain('languageOptions')
    expect(schema.properties.languageHint?.type).toBe('string')
    expect(schema.properties.transcriptionSupport).toMatchObject({
      type: 'string',
      enum: ['supported', 'unsupported', 'unknown'],
    })
    expect(schema.properties.languageOptions?.type).toBe('array')
    // The near-name collision is deliberate and must stay visible: this type-level one is the
    // service's boolean claim, the status-level one is what the plugin knows.
    expect(schema.properties).not.toHaveProperty('transcriptionSupported')
    const capabilities = (schema.properties.capabilities as unknown as {
      oneOf: readonly { properties: Record<string, { type?: string }> }[]
    }).oneOf[1]
    expect(capabilities?.properties.transcriptionSupported?.type).toBe('boolean')
  })

  it('refuses a carrier with an unknown field instead of dropping it', () => {
    // What the entry would carry verbatim: a string with one field the contract
    // does not declare. Strictness is the Host's, not the codec's.
    const smuggled = JSON.stringify({ operationId: 'op_llllllll', audioBase64: 'AA==', language: 'en' })
    const refused = parseTranscribeRequest(smuggled)
    expect(refused.ok).toBe(false)
    if (refused.ok) throw new Error('unreachable')
    expect(refused.failure.code).toBe('bad-request')

    // The codec for that parameter is a plain string schema, so nothing is stripped
    // or coerced on the way in.
    const schema = contribution.methods[`${REMOTE_NAMESPACE}/transcribe`].parameters[0]?.codec.create(smuggled)
    expect(schema?.def.type).toBe('string')
  })

  it('refuses a carrier with an unknown field on every mutating endpoint', () => {
    const cases = [
      [parseConfigureRequest, JSON.stringify({ language: 'en', requestTimeoutMs: 60_000, model: 'x', expectedRevision: 0, extra: 1 })],
      [parseAcknowledgeRequest, JSON.stringify({ operationId: null, extra: 1 })],
    ] as const
    for (const [parse, carrier] of cases) {
      const refused = parse(carrier)
      expect(refused.ok).toBe(false)
    }
  })

  it('accepts the exact carriers the client builds', () => {
    const accepted = [
      [parseTranscribeRequest, JSON.stringify({ operationId: 'op_mmmmmmmm', audioBase64: 'AA==' })],
      [parseConfigureRequest, JSON.stringify({ language: 'zh', requestTimeoutMs: 30_000, model: '', credentialRef: 'SPEECHRAIL_API_KEY', expectedRevision: 7 })],
      [parseAcknowledgeRequest, JSON.stringify({ operationId: 'op_nnnnnnnn' })],
      [parseAcknowledgeRequest, JSON.stringify({ operationId: null })],
    ] as const
    for (const [parse, carrier] of accepted) {
      expect(parse(carrier).ok).toBe(true)
    }
  })
})
