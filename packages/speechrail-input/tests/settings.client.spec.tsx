/**
 * Settings page behaviour under jsdom.
 *
 * Two writes here can mislead the user rather than merely annoy: acknowledging an
 * unproven outcome that is still outstanding, and persisting a request budget outside
 * the accepted range (a zero timeout aborts every later request immediately).
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SpeechRailSettings, type SpeechRailSettingsProps } from '../src/client/Settings.tsx'
import { MIN_REQUEST_TIMEOUT_MS } from '../src/contracts.ts'
import { failure } from '../src/host/failure.ts'
import type {
  SpeechRailAcknowledgeRequest,
  SpeechRailAcknowledgeResult,
  SpeechRailCheckResult,
  SpeechRailConfigureRequest,
  SpeechRailInputStatus,
} from '../src/types.ts'

afterEach(() => { cleanup() })

const STATUS: SpeechRailInputStatus = {
  baseUrl: 'http://127.0.0.1:8201/v1',
  endpointProblem: null,
  model: '',
  credentialRef: 'SPEECHRAIL_API_KEY',
  credentialConfigured: false,
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

/** Keeps interpolation visible, so a label's arguments can be asserted. */
const t = (key: string, values?: Record<string, unknown>): string => (
  values === undefined ? key : `${key}:${JSON.stringify(values)}`
)

/** Props with the injected face replaced by stubs. */
function props(
  overrides: Partial<SpeechRailInputStatus>,
  handlers: {
    readonly acknowledge?: (request: SpeechRailAcknowledgeRequest) => Promise<SpeechRailAcknowledgeResult>
    readonly configure?: (request: SpeechRailConfigureRequest) => Promise<{ ok: boolean; revision: number; failure: null }>
    readonly check?: () => Promise<SpeechRailCheckResult>
  } = {},
): SpeechRailSettingsProps {
  return {
    t,
    status: async () => ({ ...STATUS, ...overrides }),
    check: handlers.check ?? (async () => ({ reachable: true, authenticated: true, capabilities: null, failure: null, checkedAt: '2026-10-23T12:00:00.000Z' })),
    configure: handlers.configure ?? (async () => ({ ok: true, revision: 1, failure: null })),
    acknowledge: handlers.acknowledge ?? (async () => ({ ok: true, pendingOperationId: null, failure: null })),
  } as unknown as SpeechRailSettingsProps
}

describe('SpeechRailSettings acknowledge', () => {
  it('does not claim success while an operation still holds the gate', async () => {
    const acknowledge = vi.fn(async () => ({ ok: true, pendingOperationId: 'op_bbbbbbbb', failure: null }))
    render(<SpeechRailSettings {...props({ gate: 'unknown', pendingOperationId: 'op_bbbbbbbb' }, { acknowledge })} />)

    fireEvent.click(await screen.findByRole('button', { name: 'acknowledge' }))
    await waitFor(() => { expect(acknowledge).toHaveBeenCalledWith({ operationId: 'op_bbbbbbbb' }) })
    expect(await screen.findByText('gateBusy')).toBeTruthy()
    expect(screen.queryByText('acknowledged')).toBeNull()
  })

  it('reports success once nothing is outstanding', async () => {
    const acknowledge = vi.fn(async () => ({ ok: true, pendingOperationId: null, failure: null }))
    // The first read is the page's mount; after the acknowledgement the host reports a
    // cleared gate, which is what makes the success claim true.
    const base = props({ gate: 'unknown', pendingOperationId: 'op_cccccccc' }, { acknowledge })
    const status = vi.fn()
      .mockResolvedValueOnce({ ...STATUS, gate: 'unknown' as const, pendingOperationId: 'op_cccccccc' })
      .mockResolvedValue({ ...STATUS, gate: 'ready' as const, pendingOperationId: null })
    render(<SpeechRailSettings {...base} status={status} />)

    fireEvent.click(await screen.findByRole('button', { name: 'acknowledge' }))
    expect(await screen.findByText('acknowledged')).toBeTruthy()
  })

  it('does not claim success when the refreshed status still holds an operation', async () => {
    const acknowledge = vi.fn(async () => ({ ok: true, pendingOperationId: null, failure: null }))
    const base = props({ gate: 'unknown', pendingOperationId: 'op_dddddddd' }, { acknowledge })
    const status = vi.fn(async () => ({ ...STATUS, gate: 'unknown' as const, pendingOperationId: 'op_reappeared_9' }))
    render(<SpeechRailSettings {...base} status={status} />)

    fireEvent.click(await screen.findByRole('button', { name: 'acknowledge' }))
    expect(await screen.findByText('gateBusy')).toBeTruthy()
    expect(screen.queryByText('acknowledged')).toBeNull()
  })
})

describe('SpeechRailSettings budget', () => {
  it('clamps a value typed but not yet blurred before writing', async () => {
    // Clicking Save moves focus, but a commit that arrives before the blur must not be
    // able to persist a zero timeout, which would abort every later request at once.
    const configure = vi.fn(async () => ({ ok: true, revision: 1, failure: null }))
    render(<SpeechRailSettings {...props({}, { configure: configure as never })} />)

    const field = await screen.findByRole('spinbutton')
    fireEvent.change(field, { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: 'settings.save' }))

    await waitFor(() => {
      expect(configure).toHaveBeenCalledWith({ language: 'auto', requestTimeoutMs: MIN_REQUEST_TIMEOUT_MS, expectedRevision: 1 })
    })
  })

  it('clamps an emptied field to the accepted minimum before writing', async () => {
    const configure = vi.fn(async () => ({ ok: true, revision: 1, failure: null }))
    render(<SpeechRailSettings {...props({}, { configure: configure as never })} />)

    const field = await screen.findByRole('spinbutton')
    fireEvent.change(field, { target: { value: '' } })
    fireEvent.blur(field)
    fireEvent.click(screen.getByRole('button', { name: 'settings.save' }))

    await waitFor(() => {
      expect(configure).toHaveBeenCalledWith({ language: 'auto', requestTimeoutMs: MIN_REQUEST_TIMEOUT_MS, expectedRevision: 1 })
    })
  })
})

describe('SpeechRailSettings check result', () => {
  it('does not report a failed connection for a check that never left the host', async () => {
    const check = vi.fn(async () => ({
      reachable: false,
      authenticated: false,
      capabilities: null,
      failure: failure('not-configured'),
      checkedAt: '2026-10-23T12:00:00.000Z',
    }))
    render(<SpeechRailSettings {...props({}, { check: check as never })} />)

    fireEvent.click(await screen.findByRole('button', { name: 'settings.check' }))
    await waitFor(() => { expect(check).toHaveBeenCalled() })
    expect(screen.queryByText((content) => content.includes('settings.unreachable'))).toBeNull()
    expect(screen.getByText((content) => content.includes('settings.lastCheck'))).toBeTruthy()
  })
})

describe('SpeechRailSettings check row verdicts', () => {
  const checkWith = (result: Partial<SpeechRailCheckResult>) => vi.fn(async () => ({
    reachable: false, authenticated: false, capabilities: null, failure: null,
    checkedAt: '2026-10-23T12:00:00.000Z', ...result,
  }))

  it('prints no authentication verdict when the service never answered', async () => {
    const check = checkWith({ failure: failure('unreachable') })
    render(<SpeechRailSettings {...props({}, { check: check as never })} />)

    fireEvent.click(await screen.findByRole('button', { name: 'settings.check' }))
    expect(await screen.findByText('settings.unreachable')).toBeTruthy()
    expect(screen.queryByText((content) => content.includes('settings.authentication'))).toBeNull()
  })

  it('prints no authentication verdict when a response carried none', async () => {
    // A 200 whose body was unusable proves reachability, not a rejected credential.
    const check = checkWith({ reachable: true, failure: failure('malformed-response', { httpStatus: 200 }) })
    render(<SpeechRailSettings {...props({}, { check: check as never })} />)

    fireEvent.click(await screen.findByRole('button', { name: 'settings.check' }))
    expect(await screen.findByText('settings.connected')).toBeTruthy()
    expect(screen.queryByText((content) => content.includes('settings.authentication'))).toBeNull()
  })

  it('still reports a credential the service actually refused', async () => {
    const check = checkWith({ reachable: true, failure: failure('unauthorized', { httpStatus: 401 }) })
    render(<SpeechRailSettings {...props({}, { check: check as never })} />)

    fireEvent.click(await screen.findByRole('button', { name: 'settings.check' }))
    await waitFor(() => {
      expect(screen.getByText('settings.connected · settings.authentication:{"state":"settings.authFailed"}')).toBeTruthy()
    })
  })

  it('refreshes the snapshot without discarding an unsaved budget edit', async () => {
    render(<SpeechRailSettings {...props({}, { check: checkWith({ reachable: true, authenticated: true }) as never })} />)

    const field = await screen.findByRole('spinbutton')
    fireEvent.change(field, { target: { value: '5000' } })
    fireEvent.click(screen.getByRole('button', { name: 'settings.check' }))

    await waitFor(() => { expect(screen.getByRole('button', { name: 'settings.check' })).toBeTruthy() })
    expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('5000')
  })
})

describe('SpeechRailSettings capability label', () => {
  it('states nothing about a capability that was never determined', async () => {
    render(<SpeechRailSettings {...props({ capabilities: null })} />)

    await waitFor(() => {
      expect(screen.getByText('settings.transcriptionStatus:{"state":"settings.never"}')).toBeTruthy()
    })
    expect(screen.queryByText('settings.transcriptionStatus:{"state":"settings.unsupported"}')).toBeNull()
  })

  it('distinguishes a check that ran without a snapshot from one that never ran', async () => {
    // "Not checked yet" would be false here: the probe completed, the service just did not
    // state a capability.
    render(<SpeechRailSettings {...props({ capabilities: null, checkedAt: '2026-10-23T12:00:00.000Z' })} />)

    await waitFor(() => {
      expect(screen.getByText('settings.transcriptionStatus:{"state":"settings.undetermined"}')).toBeTruthy()
    })
    expect(screen.queryByText('settings.transcriptionStatus:{"state":"settings.never"}')).toBeNull()
  })
})
