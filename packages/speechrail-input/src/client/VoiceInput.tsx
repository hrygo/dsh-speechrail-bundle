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
import type { DictationTrigger } from './trigger.ts'
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
  /**
   * Channel opened by the keyboard command this bundle registers.
   *
   * The command is registered outside React, so it cannot hold this component; it asks the channel
   * whether a control would accept a press, and this component subscribes only while it would.
   */
  dictation: DictationTrigger
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
  /**
   * The upload this attempt started, if it got that far.
   *
   * A cancellation cannot un-send an upload: the host then records an unproven outcome and closes the
   * gate. Keeping the promise lets the cancellation reconcile that, instead of returning to idle and
   * letting the user spend their next take on an upload the host will refuse.
   */
  upload?: Promise<void> | undefined
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
  status, acknowledge, transcribe, createRecording, dictation,
}: VoiceInputProps) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [ackBusy, setAckBusy] = useState(false)
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

  const viewRef = useRef<SpeechRailInputStatus | undefined>(undefined)
  const statusSeq = useRef(0)

  const refresh = async (): Promise<SpeechRailInputStatus | undefined> => {
    const seq = ++statusSeq.current
    try {
      const next = await status()
      // A read issued before one that already landed must not overwrite the newer view.
      // This does not cover a newer request that the host answers with an older snapshot:
      // `revision` tracks settings, not the gate, so the client cannot order two responses by
      // content. See "Known limitations" in README.md.
      if (seq < statusSeq.current) return viewRef.current
      viewRef.current = next
      setView(next)
      return next
    } catch {
      return undefined
    }
  }

  const cancel = (): void => {
    // An upload already on the wire is not cancelled by the page: the host sends the abort to the
    // service, cannot prove what the service did with the audio, and keeps the attempt as unproven.
    // Reconciling that after the call settles is what keeps the next take from being spent on an
    // upload the host will refuse; a cancellation that never reached the wire leaves the gate ready
    // and this reports nothing.
    const inFlight = current.current?.phase === 'transcribing' ? current.current.upload : undefined
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
    if (inFlight !== undefined) {
      void inFlight.then(async () => {
        const reconciled = await refresh()
        if (reconciled?.gate !== 'unknown') return
        feedback(t(reconciled.capabilities == null ? 'unknownOutcomeLocal' : 'unknownOutcome', {
          detail: t('failure.cancelled'),
        }))
      })
    }
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

  /**
   * The latest press handler, refreshed after every render.
   *
   * The subscription below must not be rebuilt whenever a phase changes, and a press must read the
   * phase of the render that is on screen rather than the one it was subscribed in.
   */
  const pressRef = useRef<() => void>(() => undefined)

  useEffect(() => {
    pressRef.current = () => {
      // The same two actions the row's own controls offer: a press starts from idle and finishes a
      // live capture. Cancelling stays on Escape and on the row's own cancel, so a mis-press can
      // never discard a take.
      if (current.current?.phase === 'recording') { void finish(); return }
      if (current.current === undefined && phase === 'idle') { void start(); return }
    }
  })

  useEffect(() => {
    // A locked composer disables its own control and `start` refuses, so not subscribing is what
    // makes the command report a blocked press instead of claiming one it would drop.
    if (locked) return
    return dictation.subscribe(() => { pressRef.current() })
  }, [dictation, locked])

  const feedback = (text: string): void => { setMessage(text); setPhase('feedback') }

  const failureText = (failure: SpeechRailFailure): string => {
    const text = t(`failure.${failure.code}`)
    return failure.requestId === null ? text : `${text} (${failure.requestId})`
  }

  // What the closed gate is waiting for, plus the cause when the host knows one: the host keeps the
  // failure that left the attempt unproven, so the reason survives a page reload that forgets this
  // component's own record of it.
  const gateCause = view !== undefined && view.gate === 'unknown' && view.unprovenFailure !== null
    ? `${t('gateUnknown')} ${failureText(view.unprovenFailure)}`
    : t('gateUnknown')

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
      const upload = transcribe({ operationId: active.operationId, audioBase64: audioBase64(wave) }, active.abort.signal)
      active.upload = upload.then(() => undefined, () => undefined)
      const result = await upload
      if (run !== generation.current) return
      if (!result.ok || result.transcript === null) {
        const refreshed = await refresh()
        const failure = result.failure
        if (failure !== null && failure.outcome === 'unknown') {
          // "Check the service record" is only true of a service that keeps one. With no capability
          // snapshot in force the local journal is what recorded the attempt, so say that instead
          // of sending the user to look for a record that may not exist.
          //
          // An unproven outcome after the service answered is two facts, not one: what it said (a
          // 500, a 504, a 202, a redirect) and that it never confirmed finishing. Reporting only the
          // second would hide the first, so the failure text travels with the message.
          feedback(t(refreshed?.capabilities == null ? 'unknownOutcomeLocal' : 'unknownOutcome', {
            detail: failureText(failure),
          }))
          return
        }
        feedback(failure === null ? t('failure.internal') : failureText(failure))
        return
      }
      if (result.transcript.text === '') { feedback(t('empty')); return }
      if (!inputActions.insertText(result.transcript.text, active.span)) {
        setPending(result.transcript.text)
        feedback(t('conflict'))
        return
      }
      setMessage('')
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
    // Without a credential every upload is refused, so say so before the microphone is
    // opened rather than after a full dictation.
    // A reference that is configured but resolves to nothing will be refused on upload, so say so
    // before the microphone is opened rather than after a full dictation. An empty reference is the
    // opposite state: the endpoint needs no credential and nothing is missing.
    if (snapshot.credentialRef !== '' && !snapshot.credentialConfigured) { feedback(t('failure.not-configured')); return }
    // Same reasoning for a snapshot that already reported the operation as unsupported: the host
    // refuses that upload before the audio leaves this machine, so dictating it first would spend a
    // recording on a refusal that was known in advance. Only a snapshot can say this - an engine
    // without one is never blocked here.
    if (snapshot.capabilities !== null && !snapshot.capabilities.transcriptionSupported) {
      feedback(t('failure.unsupported'))
      return
    }
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
    if (view === undefined || ackBusy) return
    setAckBusy(true)
    // A result may arrive after the user has started recording again; reporting it must not
    // collapse the row then, or the stop button of a live microphone disappears with it.
    const report = (text: string): void => {
      // An owned capture keeps its phase: feedback would hide the transcribing indicator and
      // offer a retry that `start` refuses because the capture is still in flight.
      if (current.current !== undefined) setMessage(text)
      else feedback(text)
    }
    // A null id means the stored record could not be read at all; the Host accepts it
    // only as the user's explicit assertion that nothing of theirs is outstanding.
    try {
      const result = await acknowledge({ operationId: view.pendingOperationId })
      if (result.ok && result.pendingOperationId !== null) {
        // The host accepted the request but something else still holds the gate.
        await refresh()
        report(t('gateBusy'))
        return
      }
      if (!result.ok) {
        // A refusal can carry the id this host discovered on a re-read; refresh before
        // reporting so a second attempt sends that id instead of a stale null.
        await refresh()
        report(result.failure === null ? t('failure.internal') : failureText(result.failure))
        return
      }
      await refresh()
      // A recording may have started while this assertion was in flight. Only a live capture
      // is a reason to keep the control expanded: an attempt that aborted without recording
      // (a still-closed gate) must not swallow the acknowledgement's own success.
      if (current.current !== undefined) {
        setMessage(t('acknowledged'))
        return
      }
      setPending('')
      setMessage(t('acknowledged'))
      setPhase('idle')
    } catch {
      report(t('failure.internal'))
    } finally {
      setAckBusy(false)
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
          <button type="button" style={inlineStyle} disabled={ackBusy} onClick={() => { void acknowledgeUnknown() }}>{t('acknowledge')}</button>
        )}
        {message !== ''
          ? <span role="status" style={messageStyle} title={message}>{message}</span>
          : view?.gate === 'unknown' && (
            // The host keeps the failure that left this attempt unproven, so the cause survives a page
            // reload even though this component's own record of the attempt does not. Without it the
            // row can only say that something is unconfirmed.
            <span role="status" style={messageStyle} title={gateCause}>
              {view.unprovenFailure === null ? t('gateUnknown') : `${t('gateUnknown')} ${failureText(view.unprovenFailure)}`}
            </span>
          )}
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }} data-speechrail-activity={phase}>
      <button type="button" aria-label={t(pending === '' ? 'cancel' : 'discard')} onClick={cancel} style={roundStyle}>×</button>
      {phase === 'recording'
        ? (
          <>
            <Waveform recording={current.current?.capture} label={t('recording')} />
            {/* A result that arrived while recording must stay visible: the row keeps its stop
                control, so there is nowhere else to show it. */}
            {message !== '' && <span role="status" style={messageStyle} title={message}>{message}</span>}
          </>
        )
        : (
          <span role="status" style={messageStyle} title={pending === '' ? message : pending}>
            {phase === 'feedback'
              ? message
              : (
                <>
                  <span>{phase === 'transcribing' ? t('transcribingShort') : phase === 'checking' ? t('checking') : t('requesting')}</span>
                  {phase === 'transcribing' && (view?.languageHint ?? '') !== '' && (
                    // The hint the snapshot in force puts on the wire. The host decides it again when
                    // the upload starts, so this is the reported value, not a promise about bytes: what
                    // it is worth saying is which language is in force while dictating, since the
                    // settings page is not on screen.
                    <> · <span>{t('languageHintInline', { language: view?.languageHint ?? '' })}</span></>
                  )}
                  {message !== '' && <> · <span>{message}</span></>}
                </>
              )}
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
        <button type="button" style={inlineStyle} disabled={ackBusy} onClick={() => { void acknowledgeUnknown() }}>{t('acknowledge')}</button>
      )}
    </div>
  )
}
