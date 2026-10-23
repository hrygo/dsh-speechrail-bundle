/**
 * Settings page for the SpeechRail voice input bundle.
 * @module @hrygo/dsh-speechrail-bundle/client/Settings
 */

import { useEffect, useState, type CSSProperties } from 'react'
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

/** Render status, editable language and budget, and the probe result. */
export function SpeechRailSettings({ t, status, check, configure, acknowledge }: SpeechRailSettingsProps) {
  const [view, setView] = useState<SpeechRailInputStatus | undefined>(undefined)
  const [checked, setChecked] = useState<SpeechRailCheckResult | undefined>(undefined)
  const [language, setLanguage] = useState<SpeechRailLanguageMode>('auto')
  const [budget, setBudget] = useState(MIN_REQUEST_TIMEOUT_MS)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  const adopt = (next: SpeechRailInputStatus): void => {
    setView(next)
    setLanguage(next.language)
    setBudget(next.requestTimeoutMs)
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
      adopt(await status())
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
      const result = await configure({ language, requestTimeoutMs: budget, expectedRevision: view.revision })
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
        adopt(await status())
        setNote(result.failure === null ? t('failure.internal') : failureText(result.failure))
        return
      }
      adopt(await status())
      setNote(t('acknowledged'))
    } catch {
      setNote(t('failure.internal'))
    } finally {
      setBusy(false)
    }
  }

  const capabilities = checked?.capabilities ?? view?.capabilities ?? null
  const limits = view?.limits

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
                onChange={() => { setLanguage(mode) }}
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
          value={budget}
          onChange={(event) => { setBudget(Number(event.currentTarget.value)) }}
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
        <span style={labelStyle}>{t('settings.models')}</span>
        <span style={valueStyle}>
          {capabilities === null || capabilities === undefined
            ? t('settings.never')
            : capabilities.transcriptionSupported
              ? t('settings.supported')
              : `${t('settings.unsupported')}${capabilities.reason === null ? '' : ` (${capabilities.reason})`}`}
        </span>
        <span style={labelStyle}>
          {capabilities === null || capabilities === undefined
            ? t('settings.never')
            : t('settings.languages', { values: capabilities.languages.values.length === 0 ? '—' : capabilities.languages.values.join(', ') })}
        </span>
      </div>
      <div style={rowStyle}>
        <span style={labelStyle}>
          {checked === undefined
            ? t('settings.lastCheck', { time: view?.checkedAt ?? t('settings.never') })
            : `${checked.reachable ? t('settings.connected') : t('settings.unreachable')} · ${t('settings.authentication', {
              state: checked.authenticated ? t('settings.authOk') : t('settings.authFailed'),
            })}`}
        </span>
        {checked?.failure !== null && checked?.failure !== undefined && <span style={valueStyle}>{failureText(checked.failure)}</span>}
      </div>
    </div>
  )
}
