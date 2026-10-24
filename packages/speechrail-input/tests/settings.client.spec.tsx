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
import { languageIsAdmitted, languageOptionsFor } from '../src/host/capabilities.ts'
import { failure } from '../src/host/failure.ts'
import type { SpeechRailAcknowledgeRequest, SpeechRailAcknowledgeResult, SpeechRailCapabilitiesView, SpeechRailCheckResult, SpeechRailConfigureRequest, SpeechRailInputStatus } from '../src/types.ts'

afterEach(() => { cleanup() })

const STATUS: SpeechRailInputStatus = {
  baseUrl: 'http://127.0.0.1:8201/v1',
  endpointProblem: null,
  model: '',
  credentialRef: 'SPEECHRAIL_API_KEY',
  credentialConfigured: false,
  language: 'auto',
  languageHint: '' as const,
  transcriptionSupport: 'unknown' as const,
  languageOptions: ['auto'],
  requestTimeoutMs: 150_000,
  limits: { maxUploadBytes: 4_194_304, maxAudioSeconds: 120 },
  gate: 'ready',
  pendingOperationId: null,
  lastFailure: null,
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
    check: handlers.check ?? (async () => ({ reachable: true, authenticated: 'accepted', capabilities: null, failure: null, checkedAt: '2026-10-23T12:00:00.000Z' })),
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
      authenticated: 'unverified',
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
    reachable: false, authenticated: 'unverified', capabilities: null, failure: null,
    checkedAt: '2026-10-23T12:00:00.000Z', ...result,
  }))

  it('prints no authentication verdict when the service never answered', async () => {
    const check = checkWith({ failure: failure('unreachable') })
    render(<SpeechRailSettings {...props({}, { check: check as never })} />)

    fireEvent.click(await screen.findByRole('button', { name: 'settings.check' }))
    expect(await screen.findByText('settings.unreachable')).toBeTruthy()
    expect(screen.queryByText((content) => content.includes('settings.authentication'))).toBeNull()
  })

  it('reports the credential as unverified when a response carried no verdict', async () => {
    // A 200 whose body was unusable proves reachability, not a rejected credential, so the
    // row says so instead of staying silent about a question the user is asking.
    const check = checkWith({ reachable: true, failure: failure('malformed-response', { httpStatus: 200 }) })
    render(<SpeechRailSettings {...props({}, { check: check as never })} />)

    fireEvent.click(await screen.findByRole('button', { name: 'settings.check' }))
    expect(await screen.findByText('settings.connected · settings.authentication:{"state":"settings.authUnverified"}')).toBeTruthy()
  })

  it('still reports a credential the service actually refused', async () => {
    const check = checkWith({ reachable: true, authenticated: 'refused', failure: failure('unauthorized', { httpStatus: 401 }) })
    render(<SpeechRailSettings {...props({}, { check: check as never })} />)

    fireEvent.click(await screen.findByRole('button', { name: 'settings.check' }))
    await waitFor(() => {
      expect(screen.getByText('settings.connected · settings.authentication:{"state":"settings.authFailed"}')).toBeTruthy()
    })
  })

  it('reports the credential as unverified when the service failed without judging it', async () => {
    // A 500 says the service is up and unhappy; the credential was never judged, so the row
    // may not claim acceptance ("accepted" would be an affirmative lie) or refusal.
    const check = checkWith({ reachable: true, authenticated: 'unverified', failure: failure('server-error', { httpStatus: 500 }) })
    render(<SpeechRailSettings {...props({}, { check: check as never })} />)

    fireEvent.click(await screen.findByRole('button', { name: 'settings.check' }))
    expect(await screen.findByText('settings.connected · settings.authentication:{"state":"settings.authUnverified"}')).toBeTruthy()
  })

  it('explains a service that reports no capabilities instead of blaming the endpoint', async () => {
    // The compatibility path: a transcription-only engine answers 404 on the capability
    // endpoint. It stays usable, the snapshot stays unstated, and the credential is
    // reported as unverified rather than refused.
    const check = checkWith({ reachable: true, failure: failure('capabilities-absent', { httpStatus: 404 }) })
    render(<SpeechRailSettings {...props({}, { check: check as never })} />)

    fireEvent.click(await screen.findByRole('button', { name: 'settings.check' }))
    await waitFor(() => {
      expect(screen.getByText('settings.connected · settings.authentication:{"state":"settings.authUnverified"}')).toBeTruthy()
    })
    expect(screen.getByText('failure.capabilities-absent')).toBeTruthy()
  })

  it('adopts a value nobody edited instead of writing the stale one back', async () => {
    // The refresh moves the revision, so an untouched field must move with it; otherwise
    // the next save reverts another writer's change while passing the conflict check.
    const configure = vi.fn(async (_request: SpeechRailConfigureRequest) => ({ ok: true, revision: 2, failure: null }))
    const base = props({}, { check: checkWith({ reachable: true, authenticated: 'accepted' }) as never })
    const status = vi.fn()
      .mockResolvedValueOnce({ ...STATUS, language: 'auto' as const, requestTimeoutMs: 150_000, revision: 1 })
      .mockResolvedValue({ ...STATUS, language: 'en' as const, requestTimeoutMs: 60_000, revision: 2 })
    render(<SpeechRailSettings {...base} status={status} configure={configure as never} />)

    await waitFor(() => { expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('150000') })
    fireEvent.click(screen.getByRole('button', { name: 'settings.check' }))
    await waitFor(() => { expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('60000') })

    fireEvent.click(screen.getByRole('button', { name: 'settings.save' }))
    await waitFor(() => { expect(configure).toHaveBeenCalledWith({ language: 'en', requestTimeoutMs: 60_000, expectedRevision: 2 }) })
  })

  it('blames no service for a capability when the check never left the host', async () => {
    const check = checkWith({ failure: failure('endpoint-invalid') })
    render(<SpeechRailSettings {...props({ capabilities: null, checkedAt: '2026-10-23T12:00:00.000Z' }, { check: check as never })} />)

    fireEvent.click(await screen.findByRole('button', { name: 'settings.check' }))
    await waitFor(() => {
      expect(screen.getByText('settings.transcriptionStatus:{"state":"settings.never"}')).toBeTruthy()
    })
    expect(screen.queryByText('settings.transcriptionStatus:{"state":"settings.undetermined"}')).toBeNull()
  })

  it('keeps an edit made while the check was still in flight', async () => {
    // The dirtiness has to be read after the awaits: a state variable would be captured from
    // the render at click time, so an edit typed during the flight was overwritten.
    let release: (() => void) | undefined
    const check = vi.fn(async () => {
      await new Promise<void>((resolve) => { release = resolve })
      return { reachable: true, authenticated: 'accepted', capabilities: null, failure: null, checkedAt: '2026-10-23T12:00:00.000Z' }
    })
    const base = props({}, { check: check as never })
    const status = vi.fn()
      .mockResolvedValueOnce({ ...STATUS, language: 'auto' as const, requestTimeoutMs: 150_000, revision: 1 })
      .mockResolvedValue({ ...STATUS, language: 'zh' as const, requestTimeoutMs: 60_000, revision: 2 })
    render(<SpeechRailSettings {...base} status={status} />)

    await waitFor(() => { expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('150000') })
    fireEvent.click(screen.getByRole('button', { name: 'settings.check' }))
    await waitFor(() => { expect(check).toHaveBeenCalled() })
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '5000' } })

    release?.()
    await waitFor(() => { expect(status).toHaveBeenCalledTimes(2) })
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('5000')
  })

  it('keeps an edit made while the save was in flight, and keeps it unsaved', async () => {
    // `adopt` clears the dirty marks, so an edit typed during the save used to be shown and
    // then silently treated as saved: the next refresh replaced it with the server's value.
    let release: (() => void) | undefined
    const configure = vi.fn(async () => {
      await new Promise<void>((resolve) => { release = resolve })
      return { ok: true, revision: 2, failure: null }
    })
    const status = vi.fn()
      .mockResolvedValueOnce({ ...STATUS, requestTimeoutMs: 150_000, revision: 1 })
      .mockResolvedValue({ ...STATUS, requestTimeoutMs: 90_000, revision: 2 })
    render(<SpeechRailSettings {...props({}, { configure: configure as never })} status={status} />)

    await waitFor(() => { expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('150000') })
    fireEvent.click(screen.getByRole('button', { name: 'settings.save' }))
    await waitFor(() => { expect(configure).toHaveBeenCalled() })
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '5000' } })

    release?.()
    await waitFor(() => { expect(status).toHaveBeenCalledTimes(2) })
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('5000')
    // And the page must not claim the value was saved.
    expect(screen.queryByText('settings.saved')).toBeNull()

    // Still unsaved, so a later refresh must leave it alone.
    fireEvent.click(screen.getByRole('button', { name: 'settings.check' }))
    await waitFor(() => { expect(status).toHaveBeenCalledTimes(3) })
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('5000')
  })

  it('keeps an edit typed during the mount read, and stays unsaved', async () => {
    // The mount read decides the dirty flags. Taking the epoch after awaiting it counted an
    // edit that arrived during the read as part of the read, so the next refresh replaced it.
    let release: ((value: SpeechRailInputStatus) => void) | undefined
    const status = vi.fn()
      .mockImplementationOnce(async () => await new Promise<SpeechRailInputStatus>((resolve) => { release = resolve }))
      .mockResolvedValue({ ...STATUS, requestTimeoutMs: 90_000, revision: 2 })
    render(<SpeechRailSettings {...props({}, {})} status={status} />)

    fireEvent.change(await screen.findByRole('spinbutton'), { target: { value: '5000' } })
    release?.({ ...STATUS, requestTimeoutMs: 150_000, revision: 1 })
    await waitFor(() => { expect(status).toHaveBeenCalledTimes(1) })
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('5000')

    fireEvent.click(screen.getByRole('button', { name: 'settings.check' }))
    await waitFor(() => { expect(status).toHaveBeenCalledTimes(2) })
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('5000')
  })

  it('ignores a mount read that lands after a newer one', async () => {
    // The older read carries the older revision; applying it makes the next save send a
    // revision the host has already moved past, so the save fails as a conflict for no reason.
    let releaseMount: ((value: SpeechRailInputStatus) => void) | undefined
    const status = vi.fn()
      .mockImplementationOnce(async () => await new Promise<SpeechRailInputStatus>((resolve) => { releaseMount = resolve }))
      .mockResolvedValue({ ...STATUS, language: 'en', languageOptions: ['auto', 'zh', 'en'], requestTimeoutMs: 60_000, revision: 2 })
    const configure = vi.fn(async (_request: SpeechRailConfigureRequest) => ({ ok: true, revision: 2, failure: null }))
    render(<SpeechRailSettings {...props({}, { configure: configure as never })} status={status} />)

    fireEvent.click(screen.getByRole('button', { name: 'settings.check' }))
    await waitFor(() => { expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('60000') })
    releaseMount?.({ ...STATUS, language: 'auto', requestTimeoutMs: 150_000, revision: 1 })
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('60000')
    expect((screen.getByRole('radio', { name: 'settings.languageEn' }) as HTMLInputElement).checked).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'settings.save' }))
    await waitFor(() => { expect(configure).toHaveBeenCalled() })
    expect(configure.mock.calls[0]?.[0]).toMatchObject({ expectedRevision: 2 })
  })

  it('keeps the conflict instruction when the user edits', async () => {
    // The note is shared, so clearing it on every edit also erased the one note that says what
    // to do next: reload before saving, because the revision this page holds is stale.
    const configure = vi.fn(async (_request: SpeechRailConfigureRequest) => ({ ok: false, revision: 1, failure: failure('conflict') }))
    render(<SpeechRailSettings {...props({}, { configure: configure as never })} />)
    await waitFor(() => { expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('150000') })

    fireEvent.click(screen.getByRole('button', { name: 'settings.save' }))
    await waitFor(() => { expect(screen.getByText('settings.conflict')).toBeTruthy() })
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '60000' } })
    expect(screen.getByText('settings.conflict')).toBeTruthy()
  })

  it('says a saved language is not in effect when the service never admitted it', async () => {
    // The radio is checked and disabled at once; without this hint the control implies the
    // hint is being applied while the upload actually sends no language at all.
    const check = checkWith({ reachable: true, authenticated: 'accepted' })
    const status = vi.fn().mockResolvedValue({ ...STATUS, language: 'zh' as const, languageOptions: ['auto'] })
    render(<SpeechRailSettings {...props({}, { check: check as never })} status={status} />)

    await waitFor(() => { expect((screen.getByLabelText('settings.languageZh') as HTMLInputElement).disabled).toBe(true) })
    expect((screen.getByLabelText('settings.languageZh') as HTMLInputElement).checked).toBe(true)
    expect(screen.getByText('settings.languageNotInEffect')).toBeTruthy()
  })

  it('says a language is sent as a hint while no snapshot is in force', async () => {
    const check = checkWith({ reachable: true, authenticated: 'unverified', failure: failure('capabilities-absent', { httpStatus: 404 }) })
    const status = vi.fn().mockResolvedValue({ ...STATUS, language: 'zh' as const, languageOptions: ['auto', 'zh', 'en'] })
    render(<SpeechRailSettings {...props({}, { check: check as never })} status={status} />)

    await waitFor(() => { expect(screen.getByText('settings.languageUnverified')).toBeTruthy() })
    expect(screen.queryByText('settings.languageNotInEffect')).toBeNull()
  })

  it('labels every snapshot shape exactly as the host would act on it', async () => {
    // The table is literal data, deliberately not derived from the functions under test: `options`
    // and `sent` are what the shipped host produces for that snapshot (pinned from the host side by
    // capabilities.host.spec.ts and the conformance matrix), while the labels below are what the
    // page must render for it. A change to either side breaks exactly one of the two assertions, so
    // neither half can pass by agreeing with itself.
    const shapes: readonly {
      readonly what: string
      readonly view: SpeechRailCapabilitiesView | null
      readonly options: readonly string[]
      readonly sent: boolean
    }[] = [
      { what: 'no snapshot', view: null, options: ['auto', 'zh', 'en'], sent: true },
      { what: 'cannot transcribe', view: { schemaVersion: 'effective_capabilities_v1', transcriptionSupported: false, reason: 'asr_not_ready', languages: { status: 'unknown', values: [] }, limits: { maxUploadBytes: 1_048_576, maxAudioSeconds: 30 } }, options: ['auto'], sent: false },
      { what: 'languages refused', view: { schemaVersion: 'effective_capabilities_v1', transcriptionSupported: true, reason: null, languages: { status: 'unsupported', values: [] }, limits: { maxUploadBytes: 1_048_576, maxAudioSeconds: 30 } }, options: ['auto'], sent: false },
      { what: 'languages unstated', view: { schemaVersion: 'effective_capabilities_v1', transcriptionSupported: true, reason: null, languages: { status: 'unknown', values: [] }, limits: { maxUploadBytes: 1_048_576, maxAudioSeconds: 30 } }, options: ['auto', 'zh', 'en'], sent: true },
      { what: 'zh enumerated', view: { schemaVersion: 'effective_capabilities_v1', transcriptionSupported: true, reason: null, languages: { status: 'supported', values: ['zh', 'en'] }, limits: { maxUploadBytes: 1_048_576, maxAudioSeconds: 30 } }, options: ['auto', 'zh', 'en'], sent: true },
      { what: 'only en enumerated', view: { schemaVersion: 'effective_capabilities_v1', transcriptionSupported: true, reason: null, languages: { status: 'supported', values: ['en'] }, limits: { maxUploadBytes: 1_048_576, maxAudioSeconds: 30 } }, options: ['auto', 'en'], sent: false },
    ]

    for (const shape of shapes) {
      // Host half: the literal expectation has to match the host's own rules.
      expect(languageOptionsFor(shape.view), `${shape.what}: options`).toEqual(shape.options)
      expect(languageIsAdmitted('zh', shape.view), `${shape.what}: admitted`).toBe(shape.sent)

      // Page half: the labels have to match those literal facts.
      const status = vi.fn().mockResolvedValue({
        ...STATUS,
        language: 'zh' as const,
        languageHint: shape.sent ? 'zh' : '',
        languageOptions: shape.options,
        capabilities: shape.view,
      })
      const check = checkWith({ reachable: true, authenticated: 'accepted', capabilities: shape.view })
      const { unmount } = render(<SpeechRailSettings {...props({}, { check: check as never })} status={status} />)

      await waitFor(() => { expect(screen.getByText('settings.limitUpload', { exact: false })).toBeTruthy() })
      expect(screen.queryByText('settings.languageNotInEffect') !== null, `${shape.what}: not in effect`).toBe(!shape.sent)
      expect(screen.queryByText('settings.languageUnverified') !== null, `${shape.what}: sent as a hint`)
        .toBe(shape.sent && shape.view?.languages.status !== 'supported')
      unmount()
    }
  })

  it('marks the limits as a package default while no snapshot is in force', async () => {
    const check = checkWith({ reachable: true, authenticated: 'unverified', failure: failure('capabilities-absent', { httpStatus: 404 }) })
    render(<SpeechRailSettings {...props({}, { check: check as never })} />)

    fireEvent.click(await screen.findByRole('button', { name: 'settings.check' }))
    await waitFor(() => { expect(screen.getByText((content) => content.includes('settings.limitsDefault'))).toBeTruthy() })
  })

  it('describes one snapshot, never half of the projection and half of the last check', async () => {
    // The state is reachable: the check read a snapshot, then the status read that follows it did not
    // return one. `capabilities: null` is a real value ("no snapshot in force"), so it must not fall
    // through to the snapshot the check just read - the page would mix two snapshots in the rows
    // below the language labels, which take their options from the projection.
    const checked = {
      schemaVersion: 'effective_capabilities_v1',
      transcriptionSupported: false,
      reason: 'asr_not_ready',
      languages: { status: 'unknown', values: [] },
      limits: { maxUploadBytes: 1_048_576, maxAudioSeconds: 30 },
    } as unknown as SpeechRailCapabilitiesView
    const status = vi.fn().mockResolvedValue({
      ...STATUS,
      language: 'zh' as const,
      languageHint: 'zh',
      languageOptions: ['auto', 'zh', 'en'],
      capabilities: null,
    })
    render(<SpeechRailSettings {...props({}, { check: checkWith({ reachable: true, authenticated: 'accepted', capabilities: checked }) as never })} status={status} />)

    fireEvent.click(await screen.findByRole('button', { name: 'settings.check' }))
    // Wait until the check has landed and the projection has been re-read with no snapshot in it.
    await waitFor(() => { expect(status.mock.calls.length).toBeGreaterThan(1) })
    await waitFor(() => { expect(screen.getByText((content) => content.includes('settings.limitUpload'))).toBeTruthy() })

    // The projection is what the host enforces, so its "no snapshot" state is what the page reports:
    // the limits are the package defaults, not the 1 MiB/30 s the check happened to see.
    expect(screen.getByText((content) => content.includes('settings.limitsDefault'))).toBeTruthy()
    // And the numbers are the projection's (4 MiB here), not the 1 MiB the check happened to see.
    expect(screen.queryByText((content) => content.includes('limitUpload:{"mb":1}'))).toBeNull()
  })

  it('refreshes the snapshot without discarding an unsaved budget edit', async () => {
    render(<SpeechRailSettings {...props({}, { check: checkWith({ reachable: true, authenticated: 'accepted' }) as never })} />)

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
