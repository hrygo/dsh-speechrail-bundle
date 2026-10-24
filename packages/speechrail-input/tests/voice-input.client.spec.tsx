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
import { failure } from '../src/host/failure.ts'
import type { Recording } from '../src/client/recording.ts'
import type { SpeechRailAcknowledgeRequest, SpeechRailAcknowledgeResult, SpeechRailInputStatus } from '../src/types.ts'

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
function props(overrides: Partial<SpeechRailInputStatus>, acknowledge: (request: SpeechRailAcknowledgeRequest) => Promise<SpeechRailAcknowledgeResult>): VoiceInputProps {
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

  it('stops a recording at the limits admitted when it started', async () => {
    // The duration timer closes over the render that scheduled it. Reading the limits
    // from that stale `view` (undefined, for a click before the first status resolves)
    // made stop() see 0 bytes and discard up to the full recording as "too large".
    const stop = vi.fn(async () => new Uint8Array([1, 2, 3]))
    const capture = { start: async () => undefined, stop, dispose: async () => undefined } as unknown as Recording
    const status = vi.fn(async () => ({ ...STATUS, limits: { maxUploadBytes: 1_000, maxAudioSeconds: 0.001 } }))
    const base = props({}, vi.fn(async () => { throw new Error('unused') }))
    render(
      <VoiceInput
        {...base}
        status={status}
        createRecording={() => capture}
        transcribe={async () => ({ ok: false, transcript: null, failure: failure('audio-invalid') })}
      />,
    )

    // Click before the mount effect's status resolves: that is the render whose `finish`
    // closure the timer captures, and its `view` is still undefined.
    fireEvent.click(screen.getByRole('button', { name: 'start' }))
    await waitFor(() => { expect(screen.getByRole('button', { name: 'stop' })).toBeTruthy() })
    // The limit timer fires 1 ms after the recording starts.
    await waitFor(() => { expect(stop).toHaveBeenCalled() }, { timeout: 2_000 })
    expect(stop).toHaveBeenCalledWith(0.001, 1_000)
  })

  it('refreshes after a refusal so the next attempt carries the discovered id', async () => {
    // A transient read failure leaves the gate unproven with no id. If the Host then
    // finds a readable record it refuses the null and reports the id; the control must
    // re-read status, otherwise every later click would send the same stale null.
    let pendingId: string | null = null
    const status = vi.fn(async () => ({ ...STATUS, gate: 'unknown' as const, pendingOperationId: pendingId }))
    const acknowledge = vi.fn(async () => {
      pendingId = 'op_cccccccc'
      return { ok: false, pendingOperationId: 'op_cccccccc', failure: failure('conflict') }
    })
    const base = props({ gate: 'unknown', pendingOperationId: null }, acknowledge)
    render(<VoiceInput {...base} status={status} acknowledge={acknowledge} />)

    fireEvent.click(await screen.findByRole('button', { name: 'acknowledge' }))
    await waitFor(() => { expect(acknowledge).toHaveBeenNthCalledWith(1, { operationId: null }) })
    // The refusal triggered a re-read, which is what makes the id discoverable.
    await waitFor(() => { expect(status.mock.calls.length).toBeGreaterThanOrEqual(2) })

    fireEvent.click(screen.getByRole('button', { name: 'acknowledge' }))
    await waitFor(() => { expect(acknowledge).toHaveBeenLastCalledWith({ operationId: 'op_cccccccc' }) })
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
