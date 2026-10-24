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
import { failure, unknownFailure } from '../src/host/failure.ts'
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
  languageHint: '' as const,
  transcriptionSupport: 'unknown' as const,
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
    // Interpolating keeps the assertions honest: with `(key) => key` every language renders the
    // same text, so a positive test could not tell `zh` from `en` or from a wrong variable.
    t: (key: string, values?: Record<string, string>) =>
      (values === undefined ? key : `${key}:${JSON.stringify(values)}`),
    status: async () => ({ ...STATUS, ...overrides }),
    check: async () => ({ reachable: true, authenticated: 'accepted', capabilities: null, failure: null, checkedAt: '2026-10-23T12:00:00.000Z' }),
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

  /** Drive the control to the transcribing phase and return the release for the held request. */
  async function driveToTranscribing(languageHint: string): Promise<() => void> {
    let releaseTranscribe: (() => void) | undefined
    const capture = {
      start: async () => undefined,
      stop: vi.fn(async () => new Uint8Array([1])),
      dispose: async () => undefined,
    } as unknown as Recording
    const base = props({}, async () => ({ ok: false, pendingOperationId: null, failure: null }))
    render(
      <VoiceInput
        {...base}
        status={async () => ({ ...STATUS, language: 'zh' as const, languageHint, languageOptions: ['auto', 'zh', 'en'] })}
        createRecording={() => capture}
        transcribe={async () => {
          await new Promise<void>((resolve) => { releaseTranscribe = resolve })
          return { ok: false, transcript: null, failure: null }
        }}
      />,
    )
    fireEvent.click(await screen.findByRole('button', { name: 'start' }))
    await waitFor(() => { expect(screen.getByRole('button', { name: 'stop' })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'stop' }))
    await waitFor(() => { expect(releaseTranscribe).toBeDefined() })
    return () => { releaseTranscribe?.() }
  }

  it('says what the service answered, not only that it never confirmed', async () => {
    // A 500 that arrives in full is an unproven outcome: the service answered, and it never said it
    // finished. Reporting only the second half would hide the first, so the message carries both.
    const cases = [
      { failure: unknownFailure('server-error', { httpStatus: 500 }), detail: 'failure.server-error' },
      { failure: unknownFailure('malformed-response', { httpStatus: 202 }), detail: 'failure.malformed-response' },
      { failure: unknownFailure('timeout'), detail: 'failure.timeout' },
    ]
    for (const shape of cases) {
      const capture = {
        start: async () => undefined,
        stop: async () => new Uint8Array([1]),
        dispose: async () => undefined,
      } as unknown as Recording
      const { unmount } = render(
        <VoiceInput
          {...props({ gate: 'ready' }, async () => ({ ok: false, pendingOperationId: null, failure: null }))}
          createRecording={() => capture}
          transcribe={async () => ({ ok: false, transcript: null, failure: shape.failure })}
        />,
      )
      fireEvent.click(await screen.findByRole('button', { name: 'start' }))
      fireEvent.click(await screen.findByRole('button', { name: 'stop' }))
      await waitFor(() => {
        expect(screen.getByText(`unknownOutcomeLocal:{"detail":"${shape.detail}"}`)).toBeTruthy()
      })
      unmount()
    }
  })

  it('names the language hint that is travelling with the request', async () => {
    // The composer is where the user dictates and it has no settings page beside it, so the one
    // moment the hint matters is while the request carrying it is in flight.
    const release = await driveToTranscribing('zh')
    // The exact interpolation is the assertion: a component that passed a constant, the wrong
    // variable or an empty string would render different text.
    expect(await screen.findByText('languageHintInline:{"language":"zh"}')).toBeTruthy()
    expect(screen.queryByText(/languageHintInline:\{"language":"en"\}/)).toBeNull()
    release()
  })

  it('stays quiet while no language hint travels', async () => {
    const release = await driveToTranscribing('')
    expect(screen.getByText('transcribingShort')).toBeTruthy()
    expect(screen.queryByText(/^languageHintInline/)).toBeNull()
    release()
  })

  it('refuses before opening the microphone when the snapshot cannot transcribe', async () => {
    // The snapshot already called the operation unsupported; letting the user dictate the whole
    // thing would spend a recording on an upload the host refuses before it is sent.
    const createRecording = vi.fn()
    const base = props({}, async () => { throw new Error('not used') })
    const unsupported = {
      schemaVersion: 'effective_capabilities_v1',
      transcriptionSupported: false,
      reason: 'no asr model loaded',
      languages: { status: 'unknown' as const, values: [] },
      limits: { maxUploadBytes: 1_048_576, maxAudioSeconds: 30 },
    }
    render(<VoiceInput
      {...base}
      createRecording={createRecording as never}
      status={async () => ({ ...STATUS, capabilities: unsupported })}
    />)

    fireEvent.click(await screen.findByRole('button', { name: 'start' }))
    expect(await screen.findByText('failure.unsupported')).toBeTruthy()
    expect(createRecording).not.toHaveBeenCalled()
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

  it('submits one acknowledgement when the control is clicked twice', async () => {
    let release: (() => void) | undefined
    const acknowledge = vi.fn(async () => {
      await new Promise<void>((resolve) => { release = resolve })
      return { ok: true, pendingOperationId: null, failure: null }
    })
    render(<VoiceInput {...props({ gate: 'unknown', pendingOperationId: 'op_eeeeeeee' }, acknowledge)} />)

    const button = await screen.findByRole('button', { name: 'acknowledge' })
    fireEvent.click(button)
    fireEvent.click(button)
    release?.()
    await waitFor(() => { expect(acknowledge).toHaveBeenCalledTimes(1) })
  })

  it('keeps a live recording reachable when an acknowledgement refreshes late', async () => {
    // The assertion's own status read can land after the user has started recording again.
    // Collapsing the control then would hide the stop button of a running microphone.
    let release: ((status: SpeechRailInputStatus) => void) | undefined
    const status = vi.fn()
      .mockResolvedValueOnce({ ...STATUS, gate: 'unknown' as const, pendingOperationId: 'op_ffffffff' })
      .mockImplementationOnce(async () => await new Promise<SpeechRailInputStatus>((resolve) => { release = resolve }))
      .mockResolvedValue({ ...STATUS, gate: 'ready' as const, pendingOperationId: null })
    const base = props({ gate: 'unknown', pendingOperationId: 'op_ffffffff' }, async () => ({ ok: true, pendingOperationId: null, failure: null }))
    const stop = vi.fn(async () => new Uint8Array([1]))
    const capture = { start: async () => undefined, stop, dispose: async () => undefined } as unknown as Recording
    render(<VoiceInput {...base} status={status} createRecording={() => capture} />)

    fireEvent.click(await screen.findByRole('button', { name: 'acknowledge' }))
    await waitFor(() => { expect(status).toHaveBeenCalledTimes(2) })
    fireEvent.click(screen.getByRole('button', { name: 'start' }))
    await waitFor(() => { expect(screen.getByRole('button', { name: 'stop' })).toBeTruthy() })

    release?.({ ...STATUS, gate: 'ready' as const, pendingOperationId: null })
    // Flush the late continuation, then assert: an immediate assertion would pass before
    // React applies the state the guard is meant to withhold.
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    expect(screen.getByRole('button', { name: 'stop' })).toBeTruthy()
    // The confirmation is reported without collapsing the live control.
    expect(screen.getByText('acknowledged')).toBeTruthy()
  })

  it('keeps a live recording reachable when the acknowledgement is refused', async () => {
    // The refusal is reported as a message, not as a phase change: collapsing the row would
    // drop the stop button while the microphone is still running.
    let release: ((status: SpeechRailInputStatus) => void) | undefined
    const status = vi.fn()
      .mockResolvedValueOnce({ ...STATUS, gate: 'unknown' as const, pendingOperationId: 'op_gggggggg' })
      .mockImplementationOnce(async () => await new Promise<SpeechRailInputStatus>((resolve) => { release = resolve }))
      .mockResolvedValue({ ...STATUS, gate: 'ready' as const, pendingOperationId: null })
    const base = props({ gate: 'unknown', pendingOperationId: 'op_gggggggg' }, async () => ({ ok: false, pendingOperationId: null, failure: failure('conflict') }))
    const capture = { start: async () => undefined, stop: vi.fn(async () => new Uint8Array([1])), dispose: async () => undefined } as unknown as Recording
    render(<VoiceInput {...base} status={status} createRecording={() => capture} />)

    fireEvent.click(await screen.findByRole('button', { name: 'acknowledge' }))
    await waitFor(() => { expect(status).toHaveBeenCalledTimes(2) })
    fireEvent.click(screen.getByRole('button', { name: 'start' }))
    await waitFor(() => { expect(screen.getByRole('button', { name: 'stop' })).toBeTruthy() })

    release?.({ ...STATUS, gate: 'ready' as const, pendingOperationId: null })
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    expect(screen.getByRole('button', { name: 'stop' })).toBeTruthy()
    expect(screen.getByText('failure.conflict')).toBeTruthy()
  })

  it('still reports a success when an aborted start attempt bumped the generation', async () => {
    // Clicking the trigger while the gate is still unproven aborts without recording, so it
    // is not a reason to swallow the acknowledgement's own confirmation.
    let release: ((status: SpeechRailInputStatus) => void) | undefined
    const status = vi.fn()
      .mockResolvedValueOnce({ ...STATUS, gate: 'unknown' as const, pendingOperationId: 'op_hhhhhhhh' })
      .mockImplementationOnce(async () => await new Promise<SpeechRailInputStatus>((resolve) => { release = resolve }))
      .mockResolvedValueOnce({ ...STATUS, gate: 'unknown' as const, pendingOperationId: 'op_hhhhhhhh' })
      .mockResolvedValue({ ...STATUS, gate: 'ready' as const, pendingOperationId: null })
    const base = props({ gate: 'unknown', pendingOperationId: 'op_hhhhhhhh' }, async () => ({ ok: true, pendingOperationId: null, failure: null }))
    const createRecording = vi.fn(() => ({ start: async () => undefined, dispose: async () => undefined }) as unknown as Recording)
    render(<VoiceInput {...base} status={status} createRecording={createRecording} />)

    fireEvent.click(await screen.findByRole('button', { name: 'acknowledge' }))
    await waitFor(() => { expect(status).toHaveBeenCalledTimes(2) })
    fireEvent.click(screen.getByRole('button', { name: 'start' }))
    expect(await screen.findByText('gateUnknown')).toBeTruthy()
    expect(createRecording).not.toHaveBeenCalled()

    release?.({ ...STATUS, gate: 'ready' as const, pendingOperationId: null })
    expect(await screen.findByText('acknowledged')).toBeTruthy()
  })

  it('shows a result that arrives while the recording is being transcribed', async () => {
    // A live capture keeps its phase, and the reply is rendered beside the phase label; the
    // retry that reporting through feedback used to offer would be inert, because the capture
    // still owns the operation.
    let releaseAck: ((status: SpeechRailInputStatus) => void) | undefined
    let releaseTranscribe: (() => void) | undefined
    const status = vi.fn()
      .mockResolvedValueOnce({ ...STATUS, gate: 'unknown' as const, pendingOperationId: 'op_jjjjjjjj' })
      .mockImplementationOnce(async () => await new Promise<SpeechRailInputStatus>((resolve) => { releaseAck = resolve }))
      .mockResolvedValue({ ...STATUS, gate: 'ready' as const, pendingOperationId: null })
    const base = props({ gate: 'unknown', pendingOperationId: 'op_jjjjjjjj' }, async () => ({ ok: false, pendingOperationId: null, failure: failure('conflict') }))
    const capture = { start: async () => undefined, stop: vi.fn(async () => new Uint8Array([1])), dispose: async () => undefined } as unknown as Recording
    render(
      <VoiceInput
        {...base}
        status={status}
        createRecording={() => capture}
        transcribe={async () => {
          await new Promise<void>((resolve) => { releaseTranscribe = resolve })
          return { ok: false, transcript: null, failure: null }
        }}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'acknowledge' }))
    await waitFor(() => { expect(status).toHaveBeenCalledTimes(2) })
    fireEvent.click(screen.getByRole('button', { name: 'start' }))
    await waitFor(() => { expect(screen.getByRole('button', { name: 'stop' })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'stop' }))
    await waitFor(() => { expect(releaseTranscribe).toBeDefined() })

    releaseAck?.({ ...STATUS, gate: 'ready' as const, pendingOperationId: null })
    expect(await screen.findByText('failure.conflict')).toBeTruthy()
    // The transcribing state stays visible, and the retry it used to offer was inert because
    // the capture still owned the operation.
    expect(screen.getByText('transcribingShort')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'retryRecording' })).toBeNull()
    releaseTranscribe?.()
  })

  it('refuses before opening the microphone when no credential is configured', async () => {
    // Without a credential every upload is refused, so the refusal must arrive before a
    // whole dictation is recorded and thrown away.
    const createRecording = vi.fn(() => ({ preview: async () => { throw new Error('not used') } }) as unknown as Recording)
    const base = props({ credentialConfigured: false }, vi.fn(async () => ({ ok: true, pendingOperationId: null, failure: null })))
    render(<VoiceInput {...base} createRecording={createRecording} />)

    fireEvent.click(screen.getByRole('button', { name: 'start' }))
    expect(await screen.findByText('failure.not-configured')).toBeTruthy()
    expect(createRecording).not.toHaveBeenCalled()
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
