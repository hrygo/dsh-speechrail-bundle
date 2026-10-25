/**
 * The two halves of the composer control, rendered where the product renders them.
 *
 * The button sits after the model selector and its report before it, so the halves are two React trees.
 * They share one take through {@link SpeechRailControl}, which is the whole point of this file: the
 * combined view the other suites use could hide a broken hand-off between the seats.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SpeechRailControl } from '../src/client/control.ts'
import { createDictationTrigger } from '../src/client/trigger.ts'
import { createAnchorSeat, createPanelSeat, type SpeechRailSeatProps } from '../src/client/VoiceInput.tsx'
import type { Recording } from '../src/client/recording.ts'
import type { SpeechRailAcknowledgeRequest, SpeechRailAcknowledgeResult, SpeechRailInputStatus } from '../src/types.ts'

afterEach(() => { cleanup() })

const STATUS: SpeechRailInputStatus = {
  baseUrl: 'http://127.0.0.1:8201/v1',
  endpointProblem: null,
  model: '',
  credentialRef: '',
  credentialConfigured: false,
  language: 'auto',
  languageHint: '' as const,
  transcriptionSupport: 'unknown' as const,
  languageOptions: ['auto'],
  requestTimeoutMs: 150_000,
  limits: { maxUploadBytes: 4_194_304, maxAudioSeconds: 120 },
  gate: 'ready',
  pendingOperationId: null,
  unprovenFailure: null,
  capabilities: null,
  checkedAt: null,
  revision: 1,
}

/** The faces both seats receive from their slot. */
function seat(overrides: {
  readonly status?: Partial<SpeechRailInputStatus>
  readonly transcribe?: SpeechRailSeatProps['transcribe']
  readonly insertText?: (text: string) => boolean
} = {}): SpeechRailSeatProps {
  return {
    inputActions: {
      captureInsertion: () => ({ start: 0, end: 0 }),
      insertText: (text: string) => (overrides.insertText ?? (() => true))(text),
    },
    t: (key: string, values?: Record<string, string>) => (values === undefined ? key : `${key}:${JSON.stringify(values)}`),
    status: async () => ({ ...STATUS, ...overrides.status }),
    check: async () => ({ reachable: true, authenticated: 'accepted', capabilities: null, failure: null, checkedAt: null }),
    configure: async () => ({ ok: true, revision: 1, failure: null }),
    acknowledge: async (_request: SpeechRailAcknowledgeRequest): Promise<SpeechRailAcknowledgeResult> => ({ ok: true, pendingOperationId: null, failure: null }),
    transcribe: overrides.transcribe ?? (async () => ({
      ok: true,
      transcript: { operationId: 'op_aaaaaaaa', text: 'hello', audioSeconds: 1, requestSeconds: 0.1, inferenceSeconds: null },
      failure: null,
    })),
    createRecording: () => ({
      start: async () => undefined,
      stop: async () => new Uint8Array([1]),
      dispose: async () => undefined,
      amplitude: () => 0.1,
    }) as unknown as Recording,
    dictation: createDictationTrigger(),
  } as unknown as SpeechRailSeatProps
}

/** Render both seats the way the composer does: two trees, one control. */
function twoSeats(faces: SpeechRailSeatProps): { readonly control: SpeechRailControl } {
  const control = new SpeechRailControl()
  const Anchor = createAnchorSeat(control)
  const Panel = createPanelSeat(control)
  render(<><Anchor {...faces} /><Panel {...faces} /></>)
  return { control }
}

describe('SpeechRail split control', () => {
  it('shares one take between the two seats', async () => {
    twoSeats(seat())

    // Nothing to report before a press: the report seat holds no button of its own.
    expect(screen.queryByRole('timer')).toBeNull()
    expect(screen.getAllByRole('button', { name: 'start' })).toHaveLength(1)

    fireEvent.click(await screen.findByRole('button', { name: 'start' }))

    // The button says it is recording, and the other seat says for how long.
    expect(await screen.findByRole('button', { name: 'stop' })).toBeTruthy()
    expect(screen.getByRole('timer').textContent).toBe('0:00')
  })

  it('stops the take from the report seat', async () => {
    twoSeats(seat())
    fireEvent.click(await screen.findByRole('button', { name: 'start' }))
    await screen.findByRole('button', { name: 'stop' })

    fireEvent.click(screen.getByRole('button', { name: 'cancel' }))

    // The button in the other seat goes back to the microphone, and the clock is gone with the take.
    expect(await screen.findByRole('button', { name: 'start' })).toBeTruthy()
    expect(screen.queryByRole('timer')).toBeNull()
  })

  it('names the phase in the report, not on the button', async () => {
    let release: (() => void) | undefined
    twoSeats(seat({
      transcribe: async () => {
        await new Promise<void>((resolve) => { release = resolve })
        return {
          ok: true,
          transcript: { operationId: 'op_aaaaaaaa', text: 'hello', audioSeconds: 1, requestSeconds: 0.1, inferenceSeconds: null },
          failure: null,
        }
      },
    }))
    fireEvent.click(await screen.findByRole('button', { name: 'start' }))
    await screen.findByRole('button', { name: 'stop' })
    fireEvent.click(screen.getByRole('button', { name: 'stop' }))

    await screen.findByRole('img', { name: 'transcribingShort' })
    const anchor = document.querySelector('[data-speechrail-half="anchor"]')
    const panel = document.querySelector('[data-speechrail-half="panel"]')
    // The button keeps the work as its own glyph; the words belong to the report seat.
    expect(panel?.textContent).toContain('transcribingShort')
    expect(anchor?.textContent).not.toContain('transcribingShort')
    release?.()
  })

  it('inserts into the draft from the report seat, and never submits', async () => {
    const insertText = vi.fn(() => true)
    const submit = vi.fn(async () => undefined)
    const faces = seat({ insertText })
    const control = new SpeechRailControl()
    const Anchor = createAnchorSeat(control)
    const Panel = createPanelSeat(control)
    render(<><Anchor {...faces} /><Panel {...faces} /></>)

    fireEvent.click(await screen.findByRole('button', { name: 'start' }))
    fireEvent.click(await screen.findByRole('button', { name: 'stop' }))

    // The transcript goes into the draft through the seat that owns the draft actions, and nothing here
    // has a way to submit a message.
    await screen.findByRole('button', { name: 'start' })
    expect(insertText).toHaveBeenCalledWith('hello')
    expect(submit).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'stop' })).toBeNull()
  })
})
