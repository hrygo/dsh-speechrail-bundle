import { describe, expect, it } from 'vitest'
import { normalizeEndpoint } from '../src/host/endpoint.ts'

describe('normalizeEndpoint', () => {
  it('accepts the default numeric loopback endpoint and normalizes a trailing slash', () => {
    expect(normalizeEndpoint('http://127.0.0.1:8201/v1')).toEqual({
      ok: true,
      baseUrl: 'http://127.0.0.1:8201/v1',
      origin: 'http://127.0.0.1:8201',
    })
    expect(normalizeEndpoint('  http://127.0.0.1:8201/v1/  ')).toEqual({
      ok: true,
      baseUrl: 'http://127.0.0.1:8201/v1',
      origin: 'http://127.0.0.1:8201',
    })
  })

  it('accepts the IPv6 loopback literal', () => {
    expect(normalizeEndpoint('http://[::1]:8201/v1').ok).toBe(true)
  })

  it('refuses a DNS name even when it resolves locally', () => {
    expect(normalizeEndpoint('http://localhost:8201/v1')).toEqual({ ok: false, reason: 'not-loopback' })
  })

  it('refuses any non-loopback host', () => {
    expect(normalizeEndpoint('http://192.168.1.10:8201/v1')).toEqual({ ok: false, reason: 'not-loopback' })
    expect(normalizeEndpoint('http://example.com/v1')).toEqual({ ok: false, reason: 'not-loopback' })
  })

  it('refuses https because the credential must not travel over a proxied TLS path', () => {
    expect(normalizeEndpoint('https://127.0.0.1:8201/v1')).toEqual({ ok: false, reason: 'insecure-scheme' })
  })

  it('refuses a path other than exactly /v1', () => {
    expect(normalizeEndpoint('http://127.0.0.1:8201')).toEqual({ ok: false, reason: 'wrong-path' })
    expect(normalizeEndpoint('http://127.0.0.1:8201/v1/audio')).toEqual({ ok: false, reason: 'wrong-path' })
    expect(normalizeEndpoint('http://127.0.0.1:8201/v2')).toEqual({ ok: false, reason: 'wrong-path' })
  })

  it('refuses embedded credentials, query strings and fragments', () => {
    expect(normalizeEndpoint('http://user:pass@127.0.0.1:8201/v1')).toEqual({ ok: false, reason: 'has-credentials' })
    expect(normalizeEndpoint('http://127.0.0.1:8201/v1?token=abc')).toEqual({ ok: false, reason: 'has-query' })
    expect(normalizeEndpoint('http://127.0.0.1:8201/v1#frag')).toEqual({ ok: false, reason: 'has-fragment' })
  })

  it('refuses empty and unparsable values', () => {
    expect(normalizeEndpoint('')).toEqual({ ok: false, reason: 'not-a-url' })
    expect(normalizeEndpoint('   ')).toEqual({ ok: false, reason: 'not-a-url' })
    expect(normalizeEndpoint('127.0.0.1:8201/v1')).toEqual({ ok: false, reason: 'not-a-url' })
    expect(normalizeEndpoint('file:///v1')).toEqual({ ok: false, reason: 'insecure-scheme' })
  })
})
