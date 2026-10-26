/**
 * The Loader's parsed configuration must be readable by the Host.
 *
 * Regression guard: a `.volatile()` schema field parses to a `{ get() }` handle,
 * so reading it as a plain string still typechecks and throws at runtime. Every
 * Host entry point resolves the configuration, so this test drives the real schema
 * through the only sanctioned reader.
 */

import { describe, expect, it } from 'vitest'
import { Config, readConfig, type SpeechRailInputConfig } from '../src/host/config.ts'
import {
  DEFAULT_BASE_URL,
  DEFAULT_CREDENTIAL_REF,
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_MODEL_LENGTH,
  MAX_REQUEST_TIMEOUT_MS,
  MIN_REQUEST_TIMEOUT_MS,
} from '../src/contracts.ts'

/** Parse through the schema exactly as the Loader does. */
function parsed(raw: Record<string, unknown> = {}): SpeechRailInputConfig {
  return Config(raw) as SpeechRailInputConfig
}

describe('entry configuration', () => {
  it('parses volatile fields into handles, not plain values', () => {
    const config = parsed()
    // Documents the hazard the reader exists for: these are objects at runtime.
    expect(typeof (config.language as unknown as { get?: unknown }).get).toBe('function')
    expect(typeof (config.requestTimeoutMs as unknown as { get?: unknown }).get).toBe('function')
    // The model id is volatile too, so a settings write applies to the next upload without a reload;
    // the endpoint and the credential reference stay static on purpose (ADR-0004).
    expect(typeof (config.model as unknown as { get?: unknown }).get).toBe('function')
    expect(typeof config.baseUrl).toBe('string')
    expect(typeof config.credentialRef).toBe('string')
  })

  it('reads every default as a plain value', () => {
    expect(readConfig(parsed())).toEqual({
      baseUrl: DEFAULT_BASE_URL,
      model: '',
      credentialRef: DEFAULT_CREDENTIAL_REF,
      language: 'auto',
      requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    })
  })

  it('reads operator overrides', () => {
    const values = readConfig(parsed({
      baseUrl: 'http://localhost:8201/v1',
      model: 'asr-1.7b-q8',
      credentialRef: 'OTHER_KEY',
      language: 'zh',
      requestTimeoutMs: 30_000,
    }))
    expect(values.baseUrl).toBe('http://localhost:8201/v1')
    expect(values.model).toBe('asr-1.7b-q8')
    expect(values.credentialRef).toBe('OTHER_KEY')
    expect(values.language).toBe('zh')
    expect(values.requestTimeoutMs).toBe(30_000)
  })

  it('rejects a language outside the union and a budget outside the bounds', () => {
    expect(() => parsed({ language: 'fr' })).toThrow()
    expect(() => parsed({ requestTimeoutMs: MIN_REQUEST_TIMEOUT_MS - 1 })).toThrow()
    expect(() => parsed({ requestTimeoutMs: MAX_REQUEST_TIMEOUT_MS + 1 })).toThrow()
  })

  it('bounds the model id at load time as well as at write time', () => {
    // A configuration the settings page would refuse must not activate from the patch file either,
    // or the two paths disagree about what a valid entry is.
    expect(readConfig(parsed({ model: 'm'.repeat(MAX_MODEL_LENGTH) })).model).toHaveLength(MAX_MODEL_LENGTH)
    expect(() => parsed({ model: 'm'.repeat(MAX_MODEL_LENGTH + 1) })).toThrow()
  })

  it('accepts an empty credential reference as a deliberate no-auth endpoint', () => {
    // A local engine that authenticates nobody is a supported shape, not a mistake: the empty
    // reference is what tells it apart from a reference name that resolves to nothing.
    const values = readConfig(parsed({ credentialRef: '' }))
    expect(values.credentialRef).toBe('')
  })

  it('keeps the reference name as the default', () => {
    expect(readConfig(parsed({})).credentialRef).toBe(DEFAULT_CREDENTIAL_REF)
  })
})
