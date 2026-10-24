/**
 * Click-to-record composer control; the transcript stays in the original Session draft.
 * @module @hrygo/dsh-speechrail-bundle/client/VoiceInput
 */

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { TokenSpan } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {
  SpeechRailAcknowledgeRequest,
  SpeechRailAcknowledgeResult,
  SpeechRailCheckResult,
  SpeechRailConfigureRequest,
  SpeechRailConfigureResult,
  SpeechRailFailure,
  SpeechRailInputStatus,
  SpeechRailLimits,
  SpeechRailTranscribeRequest,
  SpeechRailTranscriptionResult,
} from '../contracts.ts'
import { NS } from './locales.ts'
import { RecordingError, audioBase64, type Recording } from './recording.ts'
import { Waveform } from './Waveform.tsx'

/** Host calls injected without exposing a Cordis Context to React. */
export interface SpeechRailActions {
  /** Read status, limits and the current gate. */
  status: () => Promise<SpeechRailInputStatus>
  /** Probe the service and refresh cached capabilities. */
  check: () => Promise<SpeechRailCheckResult>
  /** Persist language and request budget. */
  configure: (request: SpeechRailConfigureRequest) => Promise<SpeechRailConfigureResult>
  /** Clear an unproven remote outcome. */
  acknowledge: (request: SpeechRailAcknowledgeRequest) => Promise<SpeechRailAcknowledgeResult>
  /** Upload one recording exactly once. */
  transcribe: (request: SpeechRailTranscribeRequest, signal: AbortSignal) => Promise<SpeechRailTranscriptionResult>
  /** Own one microphone acquisition for the plugin lifecycle. */
  createRecording: () => Recording
}

/** Entry-injected Host operations. */
export type SpeechRailInjected = SpeechRailActions

/** Composer-owned expansion and draft actions. */
export type VoiceInputProps = Pick<PropsRuntime<'conversation.input.activity'>, 'inputActions' | 'locked' | 'onActiveChange'>
  & PropsLocale<typeof NS> & InjectFace<SpeechRailInjected>

type Phase = 'idle' | 'checking' | 'requesting' | 'recording' | 'transcribing' | 'feedback'

interface Active {
  readonly capture: Recording
  readonly abort: AbortController
  readonly span: TokenSpan
  readonly operationId: string
  /** Limits admitted when this recording started; never read from a later render. */
  readonly limits: SpeechRailLimits
  phase: 'requesting' | 'recording' | 'transcribing'
  timer?: ReturnType<typeof setTimeout> | undefined
}

/** Release one recording without hiding the transcription outcome. */
async function disposeRecording(capture: Recording): Promise<void> {
  try {
    await capture.dispose()
  } catch (_error) {
    // Tracks stop before AudioContext.close(); a close failure must not hide the result.
  }
}

const triggerStyle: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28,
  border: '1px solid var(--dsw-alias-border-secondary, #d0d0d5)', borderRadius: 14,
  background: 'transparent', color: 'inherit', cursor: 'pointer', padding: 0,
}

const roundStyle: CSSProperties = { ...triggerStyle, width: 22, height: 22 }

const inlineStyle: CSSProperties = {
  fontSize: 12, padding: '2px 8px', borderRadius: 6,
  border: '1px solid var(--dsw-alias-border-secondary, #d0d0d5)', background: 'transparent',
  color: 'inherit', cursor: 'pointer', whiteSpace: 'nowrap',
}

const messageStyle: CSSProperties = {
  fontSize: 12, maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis',
  whiteSpace: 'nowrap', color: 'var(--dsw-alias-content-secondary, inherit)',
}

/** Render a compact microphone or the expanded capture, transcription or retry row. */
export function VoiceInput({
  inputActions, locked, onActiveChange, t,
  status, acknowledge, transcribe, createRecording,
}: VoiceInputProps) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [message, setMessage] = useState('')
  const [pending, setPending] = useState('')
  const [view, setView] = useState<SpeechRailInputStatus | undefined>(undefined)
  const current = useRef<Active | undefined>(undefined)
  const generation = useRef(0)
  const expanded = phase !== 'idle'
  useLayoutEffect(() => {
    onActiveChange(expanded)
    return () => { onActiveChange(false) }
  }, [expanded, onActiveChange])

  const refresh = async (): Promise<SpeechRailInputStatus | undefined> => {
    try {
      const next = await status()
      setView(next)
      return next
    } catch {
      return undefined
    }
  }

  const cancel = (): void => {
    generation.current++
    const active = current.current
    current.current = undefined
    if (active) {
      clearTimeout(active.timer)
      active.abort.abort()
      void disposeRecording(active.capture)
    }
    setPending('')
    setMessage('')
    setPhase('idle')
  }

  useEffect(() => {
    setPending('')
    setMessage('')
    setPhase('idle')
    void refresh()
    const blur = (): void => { if (current.current?.phase === 'recording') cancel() }
    const visibility = (): void => {
      if (document.hidden && current.current && current.current.phase !== 'transcribing') cancel()
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && current.current) { event.preventDefault(); cancel() }
    }
    window.addEventListener('blur', blur)
    document.addEventListener('visibilitychange', visibility)
    document.addEventListener('keydown', escape)
    return () => {
      window.removeEventListener('blur', blur)
      document.removeEventListener('visibilitychange', visibility)
      document.removeEventListener('keydown', escape)
      generation.current++
      const active = current.current
      current.current = undefined
      if (active) {
        clearTimeout(active.timer)
        active.abort.abort()
        void disposeRecording(active.capture)
      }
    }
    // The input facade is stable per Session: a new facade invalidates the captured draft span.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputActions])

  const feedback = (text: string): void => { setMessage(text); setPhase('feedback') }

  const failureText = (failure: SpeechRailFailure): string => {
    const text = t(`failure.${failure.code}`)
    return failure.requestId === null ? text : `${text} (${failure.requestId})`
  }

  const captureText = (error: unknown): string => {
    if (error instanceof RecordingError) return t(`capture.${error.kind}`)
    return t('failure.internal')
  }

  const finish = async (): Promise<void> => {
    const active = current.current
    if (!active || active.phase !== 'recording') return
    active.phase = 'transcribing'
    const run = generation.current
    clearTimeout(active.timer)
    setPhase('transcribing')
    const limits = active.limits
    try {
      const wave = await active.capture.stop(limits.maxAudioSeconds, limits.maxUploadBytes)
      if (run !== generation.current) return
      const result = await transcribe({ operationId: active.operationId, audioBase64: audioBase64(wave) }, active.abort.signal)
      if (run !== generation.current) return
      if (!result.ok || result.transcript === null) {
        await refresh()
        const failure = result.failure
        if (failure !== null && failure.outcome === 'unknown') { feedback(t('unknownOutcome')); return }
        feedback(failure === null ? t('failure.internal') : failureText(failure))
        return
      }
      if (result.transcript.text === '') { feedback(t('empty')); return }
      if (!inputActions.insertText(result.transcript.text, active.span)) {
        setPending(result.transcript.text)
        feedback(t('conflict'))
        return
      }
      setPhase('idle')
      void refresh()
    } catch (failure) {
      await disposeRecording(active.capture)
      if (run === generation.current) feedback(captureText(failure))
    } finally {
      if (run === generation.current) current.current = undefined
    }
  }

  const start = async (): Promise<void> => {
    if (locked || current.current) return
    const run = ++generation.current
    setMessage('')
    setPending('')
    setPhase('checking')
    const snapshot = await refresh()
    if (run !== generation.current) return
    if (snapshot === undefined) { feedback(t('failure.internal')); return }
    if (snapshot.endpointProblem !== null) { feedback(t('failure.endpoint-invalid')); return }
    if (snapshot.gate === 'unknown') { feedback(t('gateUnknown')); return }
    if (snapshot.gate === 'busy') { feedback(t('gateBusy')); return }
    const capture = createRecording()
    const active: Active = {
      capture, abort: new AbortController(), span: inputActions.captureInsertion(),
      operationId: crypto.randomUUID(), phase: 'requesting', limits: snapshot.limits,
    }
    current.current = active
    setPhase('requesting')
    try {
      await capture.start((failure) => {
        if (run !== generation.current || current.current !== active || active.phase === 'transcribing') return
        current.current = undefined
        clearTimeout(active.timer)
        active.abort.abort()
        feedback(captureText(failure))
      })
      if (run !== generation.current || current.current !== active) return
      active.phase = 'recording'
      setPhase('recording')
      active.timer = setTimeout(() => { void finish() }, snapshot.limits.maxAudioSeconds * 1000)
    } catch (failure) {
      await disposeRecording(capture)
      if (run === generation.current) { current.current = undefined; feedback(captureText(failure)) }
    }
  }

  const acknowledgeUnknown = async (): Promise<void> => {
    if (view === undefined) return
    // A null id means the stored record could not be read at all; the Host accepts it
    // only as the user's explicit assertion that nothing of theirs is outstanding.
    try {
      const result = await acknowledge({ operationId: view.pendingOperationId })
      if (result.ok && result.pendingOperationId !== null) {
        // The host accepted the request but something else still holds the gate.
        await refresh()
        feedback(t('gateBusy'))
        return
      }
      if (!result.ok) {
        // A refusal can carry the id this host discovered on a re-read; refresh before
        // reporting so a second attempt sends that id instead of a stale null.
        await refresh()
        feedback(result.failure === null ? t('failure.internal') : failureText(result.failure))
        return
      }
      await refresh()
      setPending('')
      setMessage(t('acknowledged'))
      setPhase('idle')
    } catch {
      feedback(t('failure.internal'))
    }
  }

  const trigger = (
    <button
      type="button"
      title={t('dictate')}
      aria-label={t('start')}
      disabled={locked}
      onMouseDown={(event) => { event.preventDefault() }}
      onClick={() => { void start() }}
      style={{ ...triggerStyle, opacity: locked ? 0.5 : 1 }}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path
          d="M8 1.5a2.5 2.5 0 0 0-2.5 2.5v4a2.5 2.5 0 0 0 5 0V4A2.5 2.5 0 0 0 8 1.5Zm-4.5 6a.75.75 0 0 1 .75.75 3.75 3.75 0 0 0 7.5 0 .75.75 0 0 1 1.5 0 5.25 5.25 0 0 1-4.5 5.2v1.3h1.75a.75.75 0 0 1 0 1.5h-5a.75.75 0 0 1 0-1.5H7.25v-1.3a5.25 5.25 0 0 1-4.5-5.2A.75.75 0 0 1 3.5 7.5Z"
          fill="currentColor"
        />
      </svg>
    </button>
  )

  if (!expanded) {
    // A blocked gate reports itself through the message row once the user tries to
    // record, but the control that clears it must be reachable without that attempt.
    if (view?.gate !== 'unknown' && message === '') return trigger
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {trigger}
        {view?.gate === 'unknown' && (
          // Deliberately not disabled while `locked`: clearing an unproven outcome is
          // recovery, and another plugin holding the composer must not trap the gate.
          <button type="button" style={inlineStyle} onClick={() => { void acknowledgeUnknown() }}>{t('acknowledge')}</button>
        )}
        {message !== '' && <span role="status" style={messageStyle} title={message}>{message}</span>}
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }} data-speechrail-activity={phase}>
      <button type="button" aria-label={t(pending === '' ? 'cancel' : 'discard')} onClick={cancel} style={roundStyle}>×</button>
      {phase === 'recording'
        ? <Waveform recording={current.current?.capture} label={t('recording')} />
        : (
          <span role="status" style={messageStyle} title={pending === '' ? message : pending}>
            {phase === 'feedback' ? message : t(phase === 'transcribing' ? 'transcribingShort' : 'requesting')}
          </span>
        )}
      {phase === 'recording' && (
        <button type="button" aria-label={t('stop')} onClick={() => { void finish() }} style={roundStyle}>■</button>
      )}
      {phase === 'feedback' && (pending !== ''
        ? (
          <button type="button" style={inlineStyle} onClick={() => {
            if (inputActions.insertText(pending, inputActions.captureInsertion())) { setPending(''); setMessage(''); setPhase('idle') }
          }}>{t('insert')}</button>
        )
        : (
          <button type="button" style={inlineStyle} disabled={locked} onClick={() => { void start() }}>{t('retryRecording')}</button>
        ))}
      {view?.gate === 'unknown' && (
        <button type="button" style={inlineStyle} onClick={() => { void acknowledgeUnknown() }}>{t('acknowledge')}</button>
      )}
    </div>
  )
}
