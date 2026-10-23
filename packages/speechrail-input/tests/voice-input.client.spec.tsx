/**
 * Composer control behaviour under jsdom.
 *
 * The acknowledge path is the one place where the client must not silently do
 * nothing: an unproven outcome blocks every further recording, and the stored record
 * may be unreadable, in which case the client sends an explicit `null` id that the
 * Host accepts only as the user's assertion that nothing is outstanding.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VoiceInput, type VoiceInputProps } from '../src/client/VoiceInput.tsx'
import type { SpeechRailAcknowledgeRequest, SpeechRailInputStatus } from '../src/types.ts'

afterEach(() => { cleanup() })

const STATUS: SpeechRailInputStatus = {
  baseUrl: 'http://127.0.0.1:8201/v1',
  endpointProblem: null,
  model: '',
  credentialRef: 'SPEECHRAIL_API_KEY',
  credentialConfigured: true,
  language: 'auto',
  languageOptions: ['auto'],
  requestTimeoutMs: 150_000,
  limits: { maxUploadBytes: 4_194_304, maxAudioSeconds: 120 },
  gate: 'ready',
  pendingOperationId: null,
  capabilities: null,
  checkedAt: null,
  revision: 1,
}

/** Props with the injected face replaced by recording stubs. */
function props(overrides: Partial<SpeechRailInputStatus>, acknowledge: (request: SpeechRailAcknowledgeRequest) => Promise<never>): VoiceInputProps {
  return {
    inputActions: {
      captureInsertion: () => ({ start: 0, end: 0 }),
      insertText: () => true,
    },
    locked: false,
    onActiveChange: () => { /* observation only */ },
    t: (key: string) => key,
    status: async () => ({ ...STATUS, ...overrides }),
    check: async () => ({ reachable: true, authenticated: true, capabilities: null, failure: null, checkedAt: '2026-10-23T12:00:00.000Z' }),
    configure: async () => ({ ok: true, revision: 1, failure: null }),
    acknowledge,
    transcribe: async () => ({ ok: false, transcript: null, failure: null }),
    createRecording: () => ({ preview: async () => { throw new Error('not used') } }),
  } as unknown as VoiceInputProps
}

describe('VoiceInput acknowledge', () => {
  it('sends the recorded operation id and reports the outcome', async () => {
    const acknowledge = vi.fn(async () => { throw new Error('refused') })
    render(<VoiceInput {...props({ gate: 'unknown', pendingOperationId: 'op_aaaaaaaa' }, acknowledge)} />)

    fireEvent.click(await screen.findByRole('button', { name: 'acknowledge' }))
    await waitFor(() => { expect(acknowledge).toHaveBeenCalledWith({ operationId: 'op_aaaaaaaa' }) })
    expect(await screen.findByText('failure.internal')).toBeTruthy()
  })

  it('sends an explicit null when the stored record was unreadable', async () => {
    // Previously the control returned silently here, leaving the gate closed forever.
    const acknowledge = vi.fn(async () => { throw new Error('refused') })
    render(<VoiceInput {...props({ gate: 'unknown', pendingOperationId: null }, acknowledge)} />)

    fireEvent.click(await screen.findByRole('button', { name: 'acknowledge' }))
    await waitFor(() => { expect(acknowledge).toHaveBeenCalledWith({ operationId: null }) })
  })

  it('offers no acknowledge control while the gate is open', async () => {
    const acknowledge = vi.fn(async () => { throw new Error('unused') })
    render(<VoiceInput {...props({ gate: 'ready' }, acknowledge)} />)

    // Wait for the first status read, then assert the control is absent.
    await waitFor(() => { expect(screen.getByRole('button', { name: 'start' })).toBeTruthy() })
    expect(screen.queryByRole('button', { name: 'acknowledge' })).toBeNull()
    expect(acknowledge).not.toHaveBeenCalled()
  })
})
