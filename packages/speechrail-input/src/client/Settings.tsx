/**
 * Settings page for the SpeechRail voice input bundle.
 * @module @hrygo/dsh-speechrail-bundle/client/Settings
 */

import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import {
  MAX_REQUEST_TIMEOUT_MS,
  MIN_REQUEST_TIMEOUT_MS,
  type SpeechRailCheckResult,
  type SpeechRailFailure,
  type SpeechRailInputStatus,
  type SpeechRailLanguageMode,
} from '../contracts.ts'
import { NS, type SpeechRailKey } from './locales.ts'
import type { SpeechRailInjected } from './VoiceInput.tsx'

/** Full props of the bundle configuration page. */
export type SpeechRailSettingsProps = PropsRuntime<'plugins.bundle.config'> & PropsLocale<typeof NS> & InjectFace<SpeechRailInjected>

const rowStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }
const labelStyle: CSSProperties = { fontSize: 12, color: 'var(--dsw-alias-content-secondary, #6b6b70)' }
const valueStyle: CSSProperties = { fontSize: 13 }
const buttonStyle: CSSProperties = {
  fontSize: 12, padding: '3px 10px', borderRadius: 6,
  border: '1px solid var(--dsw-alias-border-secondary, #d0d0d5)', background: 'transparent',
  color: 'inherit', cursor: 'pointer',
}

/**
 * Keep the persisted budget inside the range the Host schema accepts.
 *
 * The field is free text while it is being edited, so an empty or out-of-range value
 * could otherwise be written: `settings.write` re-validates shape and volatility, not
 * `min`/`max`, and a zero timeout aborts every later request immediately.
 * @param text - the raw field value.
 * @returns a value within [MIN_REQUEST_TIMEOUT_MS, MAX_REQUEST_TIMEOUT_MS].
 */
function clampBudget(text: string): number {
  const parsed = Number(text)
  if (!Number.isFinite(parsed) || text.trim() === '') return MIN_REQUEST_TIMEOUT_MS
  return Math.min(MAX_REQUEST_TIMEOUT_MS, Math.max(MIN_REQUEST_TIMEOUT_MS, Math.round(parsed)))
}

/** Render status, editable language and budget, and the probe result. */
export function SpeechRailSettings({ t, status, check, configure, acknowledge }: SpeechRailSettingsProps) {
  const [view, setView] = useState<SpeechRailInputStatus | undefined>(undefined)
  const [checked, setChecked] = useState<SpeechRailCheckResult | undefined>(undefined)
  const [language, setLanguage] = useState<SpeechRailLanguageMode>('auto')
  const [budgetText, setBudgetText] = useState(String(MIN_REQUEST_TIMEOUT_MS))
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  // A refresh must replace the fields the user has not touched, or the page would keep a
  // stale value while adopting the fresh revision and write it back over someone else's
  // change. These live in refs because the value is read *after* an await: a state variable
  // would be captured from the render at click time, so an edit made while a check or a save
  // was in flight would still be overwritten.
  const languageDirty = useRef(false)
  const budgetDirty = useRef(false)

  /** Show fresh values, keeping anything the user has edited and not saved. */
  const applyStatus = (next: SpeechRailInputStatus): void => {
    setView(next)
    if (!languageDirty.current) setLanguage(next.language)
    if (!budgetDirty.current) setBudgetText(String(next.requestTimeoutMs))
  }

  const adopt = (next: SpeechRailInputStatus): void => {
    applyStatus(next)
    languageDirty.current = false
    budgetDirty.current = false
  }

  const failureText = (failure: SpeechRailFailure): string => {
    const text = t(`failure.${failure.code}` as SpeechRailKey)
    return failure.requestId === null ? text : `${text} (${failure.requestId})`
  }

  useEffect(() => {
    void (async () => {
      try {
        adopt(await status())
      } catch {
        setNote(t('failure.internal'))
      }
    })()
    // The page reads once per mount; every write refreshes explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const runCheck = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await check()
      setChecked(result)
      // Refresh the snapshot and every field the user has not edited; adopting wholesale
      // would discard an edit in progress, and refreshing only the view would leave an
      // untouched field stale while its conflict token moves on.
      applyStatus(await status())
    } catch {
      setNote(t('failure.internal'))
    } finally {
      setBusy(false)
    }
  }

  const save = async (): Promise<void> => {
    if (view === undefined) return
    setBusy(true)
    setNote('')
    try {
      const timeout = clampBudget(budgetText)
      setBudgetText(String(timeout))
      const result = await configure({ language, requestTimeoutMs: timeout, expectedRevision: view.revision })
      if (result.ok) {
        adopt(await status())
        setNote(t('settings.saved'))
        return
      }
      const failure = result.failure
      if (failure !== null && failure.code === 'conflict') { setNote(t('settings.conflict')); return }
      if (failure !== null && failure.code === 'internal') { setNote(t('settings.unavailable')); return }
      setNote(failure === null ? t('failure.internal') : failureText(failure))
    } catch {
      setNote(t('failure.internal'))
    } finally {
      setBusy(false)
    }
  }

  const acknowledgeUnknown = async (): Promise<void> => {
    if (view === undefined) return
    // A null id means the stored record could not be read at all; the Host accepts it
    // only as the user's explicit assertion that nothing of theirs is outstanding.
    setBusy(true)
    try {
      const result = await acknowledge({ operationId: view.pendingOperationId })
      if (!result.ok) {
        // A refusal can carry the id this host discovered on a re-read; refresh before
        // reporting so a second attempt sends that id instead of a stale null.
        applyStatus(await status())
        setNote(result.failure === null ? t('failure.internal') : failureText(result.failure))
        return
      }
      const fresh = await status()
      applyStatus(fresh)
      if (result.pendingOperationId !== null || fresh.pendingOperationId !== null) {
        // The Host accepted the request but something still holds the gate (now, or as the
        // refreshed status reports), so claiming success here would be false.
        setNote(t('gateBusy'))
        return
      }
      setNote(t('acknowledged'))
    } catch {
      setNote(t('failure.internal'))
    } finally {
      setBusy(false)
    }
  }

  const capabilities = checked?.capabilities ?? view?.capabilities ?? null
  const limits = view?.limits
  // A probe that ran and produced no snapshot is not the same as one that never ran.
  // A check the host refused locally (no credential, unusable endpoint) never reached the
  // service, so it must not blame the service for not stating a capability.
  const neverAskedLocally = checked !== undefined
    && (checked.failure?.code === 'not-configured' || checked.failure?.code === 'endpoint-invalid')
  const checkedYet = !neverAskedLocally && (checked !== undefined || (view?.checkedAt ?? null) !== null)
  const lastCheckTime = checked?.checkedAt ?? view?.checkedAt ?? t('settings.never')
  // A verdict is reported only when a response carried one: `authenticated` is false both
  // when the credential was refused and when nothing judged it, and true only after a 200.
  const verified = checked !== undefined && (checked.failure?.code === 'unauthorized' || checked.failure === null)

  return (
    <div style={{ fontSize: 13 }}>
      <div style={rowStyle}>
        <span style={valueStyle}>{t('settings.description')}</span>
      </div>
      <div style={rowStyle}>
        <span style={labelStyle}>{t('settings.endpoint')}</span>
        <span style={valueStyle}>{view?.baseUrl ?? '—'}</span>
        <span style={labelStyle}>{t('settings.endpointNote')}</span>
        {view?.endpointProblem !== null && view?.endpointProblem !== undefined && (
          <span style={{ ...valueStyle, color: 'var(--dsw-alias-content-error, #c0392b)' }}>{t('failure.endpoint-invalid')}</span>
        )}
      </div>
      <div style={rowStyle}>
        <span style={labelStyle}>{t('settings.credential')}</span>
        <span style={valueStyle}>
          {view?.credentialConfigured === true
            ? t('settings.credentialConfigured', { ref: view.credentialRef })
            : t('settings.credentialMissing', { ref: view?.credentialRef ?? '—' })}
        </span>
      </div>
      <div style={rowStyle}>
        <span style={labelStyle}>{t('settings.gate')}</span>
        <span style={valueStyle}>
          {view?.gate === 'unknown' ? t('gateUnknown') : view?.gate === 'busy' ? t('gateBusy') : t('gateReady')}
        </span>
        {view?.pendingOperationId !== null && view?.pendingOperationId !== undefined && (
          <span style={valueStyle}>{t('settings.pendingOperation', { id: view.pendingOperationId })}</span>
        )}
        {view?.gate === 'unknown' && (
          <button type="button" style={buttonStyle} disabled={busy} onClick={() => { void acknowledgeUnknown() }}>{t('acknowledge')}</button>
        )}
      </div>
      <div style={rowStyle}>
        <span style={labelStyle}>{t('settings.language')}</span>
        <span style={{ display: 'flex', gap: 12 }}>
          {(['auto', 'zh', 'en'] as const).map((mode) => (
            <label key={mode} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <input
                type="radio"
                name="speechrail-language"
                checked={language === mode}
                disabled={view !== undefined && !view.languageOptions.includes(mode)}
                onChange={() => { setLanguage(mode); languageDirty.current = true }}
              />
              {t(mode === 'auto' ? 'settings.languageAuto' : mode === 'zh' ? 'settings.languageZh' : 'settings.languageEn')}
            </label>
          ))}
        </span>
      </div>
      <div style={rowStyle}>
        <span style={labelStyle}>{t('settings.budget')}</span>
        <input
          type="number"
          min={MIN_REQUEST_TIMEOUT_MS}
          max={MAX_REQUEST_TIMEOUT_MS}
          step={1000}
          value={budgetText}
          onChange={(event) => { setBudgetText(event.currentTarget.value); budgetDirty.current = true }}
          onBlur={() => { setBudgetText(String(clampBudget(budgetText))) }}
          style={{ ...valueStyle, width: 120 }}
        />
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <button type="button" style={buttonStyle} disabled={busy || view === undefined} onClick={() => { void save() }}>{t('settings.save')}</button>
        <button type="button" style={buttonStyle} disabled={busy} onClick={() => { void runCheck() }}>{busy ? t('settings.checking') : t('settings.check')}</button>
        {note !== '' && <span style={labelStyle}>{note}</span>}
      </div>
      <div style={rowStyle}>
        <span style={labelStyle}>{t('settings.limits')}</span>
        {limits !== undefined && (
          <span style={valueStyle}>
            {t('settings.limitUpload', { mb: Math.round(limits.maxUploadBytes / 1024 / 1024) })}
            {' · '}
            {t('settings.limitDuration', { seconds: limits.maxAudioSeconds })}
          </span>
        )}
      </div>
      <div style={rowStyle}>
        <span style={labelStyle}>{t('settings.transcriptionStatus', {
          state: capabilities === null || capabilities === undefined
            ? t(checkedYet ? 'settings.undetermined' : 'settings.never')
            : capabilities.transcriptionSupported
              ? t('settings.available')
              : t('settings.unsupported'),
        })}</span>
        <span style={valueStyle}>
          {capabilities === null || capabilities === undefined
            ? t(checkedYet ? 'settings.undetermined' : 'settings.never')
            : capabilities.transcriptionSupported
              ? t('settings.supported')
              : `${t('settings.unsupported')}${capabilities.reason === null ? '' : ` (${capabilities.reason})`}`}
        </span>
        <span style={labelStyle}>
          {capabilities === null || capabilities === undefined
            ? t(checkedYet ? 'settings.undetermined' : 'settings.never')
            : t('settings.languages', { values: capabilities.languages.values.length === 0 ? '—' : capabilities.languages.values.join(', ') })}
        </span>
      </div>
      <div style={rowStyle}>
        <span style={labelStyle}>
          {checked === undefined || checked.failure?.code === 'not-configured' || checked.failure?.code === 'endpoint-invalid'
            // A check that never reached the service must not be reported as a failed
            // connection to a healthy one.
            ? t('settings.lastCheck', { time: lastCheckTime })
            : verified
              // `authenticated: false` covers "refused" and "never judged" alike, so it is
              // only reported once a response actually carried a verdict.
              ? `${t('settings.connected')} · ${t('settings.authentication', { state: checked.authenticated ? t('settings.authOk') : t('settings.authFailed') })}`
              : checked.reachable
                ? t('settings.connected')
                : t('settings.unreachable')}
        </span>
        {checked?.failure !== null && checked?.failure !== undefined && <span style={valueStyle}>{failureText(checked.failure)}</span>}
      </div>
    </div>
  )
}
