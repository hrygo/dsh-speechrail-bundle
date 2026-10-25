/**
 * The composer microphone as one state machine, drawn by two slots.
 *
 * The button sits after the model selector, and what a press produces - timer, cancel, message,
 * insert - stays in the control group before it. Two components in two slots cannot own one take, so
 * the state lives here: one microphone, one take at a time, two views over the same snapshot.
 *
 * Everything in the snapshot is raw state. Phase names, colours and failure text are derived by the
 * views from their own localized `t`, so binding a face never invalidates what the other view reads.
 * @module @hrygo/dsh-speechrail-bundle/client/control
 */

import { useEffect, useState, useSyncExternalStore } from 'react'
import type { PropsLocale, PropsRuntime, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { InputActions, TokenSpan } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {
  SpeechRailAcknowledgeRequest,
  SpeechRailAcknowledgeResult,
  SpeechRailCheckResult,
  SpeechRailConfigureRequest,
  SpeechRailConfigureResult,
  SpeechRailInputStatus,
  SpeechRailLimits,
  SpeechRailTranscribeRequest,
  SpeechRailTranscriptionResult,
} from '../contracts.ts'
import { failureText } from './failure-text.ts'
import { NS } from './locales.ts'
import { RecordingError, audioBase64, type Recording } from './recording.ts'
import type { DictationTrigger } from './trigger.ts'

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
   * Separate from the seat's own props on purpose: whether a control would accept a press is told to
   * the seat, and this channel must stay open across every composer state.
   */
  dictation: DictationTrigger
}

/** Entry-injected Host operations. */
export type SpeechRailInjected = SpeechRailActions

/** Locale function as a seat receives it: typed by this bundle's own dictionary. */
export type LocaleText = PropsLocale<typeof NS>['t']

/** Locale function, widened: only this bundle's own message keys pass through the control. */
export type Translate = (key: string, values?: Record<string, unknown>) => string

/** What both seats provide: this Session's draft actions, its dictionary and the Host face. */
export type SpeechRailSeatProps = Pick<PropsRuntime<'conversation.input.right'>, 'inputActions'>
  & PropsLocale<typeof NS> & InjectFace<SpeechRailInjected>

/** The face a single-seat render needs, as the tests and the combined view pass it. */
export type VoiceInputProps = SpeechRailSeatProps

/** Which part of the control's life the microphone is in. */
export type Phase = 'idle' | 'checking' | 'requesting' | 'recording' | 'transcribing' | 'feedback'

/**
 * How a message reads.
 *
 * One grey for a refusal and for "working on it" made the row's worst states look like its best ones,
 * so the kind travels with the text and picks the colour.
 */
export type MessageKind = 'info' | 'warn' | 'error' | 'success'

/** Everything either view draws, as raw state. */
export interface ControlSnapshot {
  readonly phase: Phase
  readonly message: string
  readonly messageKind: MessageKind
  /** A transcript the draft refused, kept for a later insertion. */
  readonly pending: string
  /** Whole seconds the live take has run. */
  readonly elapsed: number
  readonly gate: SpeechRailInputStatus['gate'] | undefined
  readonly pendingOperationId: SpeechRailInputStatus['pendingOperationId'] | undefined
  readonly unprovenFailure: SpeechRailInputStatus['unprovenFailure'] | undefined
  /** The language hint in force for the take being transcribed. */
  readonly languageHint: string
  readonly ackBusy: boolean
  /** The live acquisition, so the waveform can sample it; only set while recording. */
  readonly capture: Recording | undefined
}

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

const EMPTY: ControlSnapshot = {
  phase: 'idle', message: '', messageKind: 'info', pending: '', elapsed: 0,
  gate: undefined, pendingOperationId: null, unprovenFailure: null, languageHint: '', ackBusy: false,
  capture: undefined,
}

/**
 * One microphone, shared by the two slots it is drawn in.
 *
 * Bound by whichever half renders, and disposed with the plugin: the browser listeners that cancel a
 * take (Escape, window blur, a hidden page) belong to the control, not to a component that a composer
 * change could unmount mid-take.
 */
export class SpeechRailControl {
  private readonly listeners = new Set<() => void>()
  private snapshot: ControlSnapshot = EMPTY
  private faces: { injected: SpeechRailInjected; inputActions: InputActions } | undefined
  private dictationOff: (() => void) | undefined
  private started = false
  private active: Active | undefined
  private generation = 0
  private view: SpeechRailInputStatus | undefined
  private statusSeq = 0
  private ticker: ReturnType<typeof setInterval> | undefined
  private translate: Translate | undefined

  private readonly onBlur = (): void => { if (this.active?.phase === 'recording') this.cancel() }
  private readonly onVisibility = (): void => {
    if (document.hidden && this.active !== undefined && this.active.phase !== 'transcribing') this.cancel()
  }
  private readonly onKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && this.active !== undefined) { event.preventDefault(); this.cancel() }
  }

  constructor() {
    window.addEventListener('blur', this.onBlur)
    document.addEventListener('visibilitychange', this.onVisibility)
    document.addEventListener('keydown', this.onKeydown)
  }

  /** The snapshot React reads; the same object until something actually changes. */
  readonly getSnapshot = (): ControlSnapshot => this.snapshot

  /** Subscribe to state changes. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Adopt the faces of the half that just rendered.
   *
   * Both halves carry the same injected Host calls and the same Session draft actions, so the last one
   * to render wins - the microphone is one resource, and the composer on screen is the one it serves.
   * The first bind also reads the status once, which is what a mount used to do.
   * @param injected - the Host face and the dictation channel.
   * @param inputActions - this Session's draft actions.
   * @param translate - the locale both halves share.
   */
  bind(injected: SpeechRailInjected, inputActions: InputActions, translate: Translate): void {
    this.translate = translate
    if (this.faces?.injected.dictation !== injected.dictation) {
      this.dictationOff?.()
      // Subscribing in every composer state is deliberate: this seat is told nothing about a composer
      // that refuses interaction, and a draft that refuses the insertion keeps the transcript in the
      // row for a later attempt, so a press is never silently dropped.
      this.dictationOff = injected.dictation.subscribe(() => { this.press() })
    }
    this.faces = { injected, inputActions }
    if (this.started) return
    this.started = true
    void this.refresh()
  }

  /** Stop owning the microphone and every listener. */
  dispose(): void {
    window.removeEventListener('blur', this.onBlur)
    document.removeEventListener('visibilitychange', this.onVisibility)
    document.removeEventListener('keydown', this.onKeydown)
    this.dictationOff?.()
    this.dictationOff = undefined
    this.listeners.clear()
    this.stopTicker()
    this.generation++
    const active = this.active
    this.active = undefined
    if (active !== undefined) {
      clearTimeout(active.timer)
      active.abort.abort()
      void disposeRecording(active.capture)
    }
  }

  /** The keyboard's press: start from idle, finish a live take, and change nothing else. */
  press(): void {
    if (this.active?.phase === 'recording') { void this.finish(); return }
    if (this.active === undefined && this.snapshot.phase === 'idle') void this.start()
  }

  /** Open the microphone, after checking everything that would make the upload pointless. */
  async start(): Promise<void> {
    if (this.active !== undefined) return
    const run = ++this.generation
    this.setState({ message: '', pending: '', phase: 'checking' })
    const snapshot = await this.refresh()
    if (run !== this.generation) return
    if (snapshot === undefined) { this.feedback(this.t('failure.internal')); return }
    if (snapshot.endpointProblem !== null) { this.feedback(this.t('failure.endpoint-invalid')); return }
    if (snapshot.gate === 'unknown') { this.feedback(this.t('gateUnknown'), 'warn'); return }
    if (snapshot.gate === 'busy') { this.feedback(this.t('gateBusy'), 'warn'); return }
    // A reference that is configured but resolves to nothing will be refused on upload, so say so
    // before the microphone is opened rather than after a full dictation. An empty reference is the
    // opposite state: the endpoint needs no credential and nothing is missing.
    if (snapshot.credentialRef !== '' && !snapshot.credentialConfigured) { this.feedback(this.t('failure.not-configured')); return }
    // Same reasoning for a snapshot that already reported the operation as unsupported: the host
    // refuses that upload before the audio leaves this machine, so dictating it first would spend a
    // recording on a refusal that was known in advance. Only a snapshot can say this - an engine
    // without one is never blocked here.
    if (snapshot.capabilities !== null && !snapshot.capabilities.transcriptionSupported) {
      this.feedback(this.t('failure.unsupported'))
      return
    }
    const capture = this.take().injected.createRecording()
    const active: Active = {
      capture, abort: new AbortController(), span: this.take().inputActions.captureInsertion(),
      operationId: crypto.randomUUID(), phase: 'requesting', limits: snapshot.limits,
    }
    this.active = active
    this.setState({ phase: 'requesting' })
    try {
      await capture.start((failure) => {
        if (run !== this.generation || this.active !== active || active.phase === 'transcribing') return
        this.active = undefined
        clearTimeout(active.timer)
        active.abort.abort()
        this.feedback(this.captureText(failure))
      })
      if (run !== this.generation || this.active !== active) return
      active.phase = 'recording'
      this.setState({ phase: 'recording', elapsed: 0, capture })
      this.startTicker()
      active.timer = setTimeout(() => { void this.finish() }, snapshot.limits.maxAudioSeconds * 1000)
    } catch (failure) {
      await disposeRecording(capture)
      if (run === this.generation) { this.active = undefined; this.feedback(this.captureText(failure)) }
    }
  }

  /** Stop the take, upload it once and insert what comes back. */
  async finish(): Promise<void> {
    const active = this.active
    if (active === undefined || active.phase !== 'recording') return
    active.phase = 'transcribing'
    const run = this.generation
    clearTimeout(active.timer)
    this.setState({ phase: 'transcribing' })
    const limits = active.limits
    try {
      const wave = await active.capture.stop(limits.maxAudioSeconds, limits.maxUploadBytes)
      if (run !== this.generation) return
      const upload = this.take().injected.transcribe(
        { operationId: active.operationId, audioBase64: audioBase64(wave) }, active.abort.signal,
      )
      active.upload = upload.then(() => undefined, () => undefined)
      const result = await upload
      if (run !== this.generation) return
      if (!result.ok || result.transcript === null) {
        const refreshed = await this.refresh()
        const failure = result.failure
        if (failure !== null && failure.outcome === 'unknown') {
          // "Check the service record" is only true of a service that keeps one. With no capability
          // snapshot in force the local journal is what recorded the attempt, so say that instead
          // of sending the user to look for a record that may not exist.
          //
          // An unproven outcome after the service answered is two facts, not one: what it said (a
          // 500, a 504, a 202, a redirect) and that it never confirmed finishing. Reporting only the
          // second would hide the first, so the failure text travels with the message.
          this.feedback(this.t(refreshed?.capabilities == null ? 'unknownOutcomeLocal' : 'unknownOutcome', {
            detail: failureText(this.t, failure),
          }))
          return
        }
        this.feedback(failure === null ? this.t('failure.internal') : failureText(this.t, failure))
        return
      }
      if (result.transcript.text === '') { this.feedback(this.t('empty')); return }
      if (!this.take().inputActions.insertText(result.transcript.text, active.span)) {
        // The transcript is kept and offered for insertion, so this is a caution rather than a loss.
        this.setState({ pending: result.transcript.text })
        this.feedback(this.t('conflict'), 'warn')
        return
      }
      this.setState({ message: '', phase: 'idle' })
      void this.refresh()
    } catch (failure) {
      await disposeRecording(active.capture)
      if (run === this.generation) this.feedback(this.captureText(failure))
    } finally {
      if (run === this.generation) this.active = undefined
    }
  }

  /** Discard the live take without sending anything. */
  cancel(): void {
    // An upload already on the wire is not cancelled by the page: the host sends the abort to the
    // service, cannot prove what the service did with the audio, and keeps the attempt as unproven.
    // Reconciling that after the call settles is what keeps the next take from being spent on an
    // upload the host will refuse; a cancellation that never reached the wire leaves the gate ready
    // and this reports nothing.
    const inFlight = this.active?.phase === 'transcribing' ? this.active.upload : undefined
    this.generation++
    const active = this.active
    this.active = undefined
    if (active !== undefined) {
      clearTimeout(active.timer)
      active.abort.abort()
      void disposeRecording(active.capture)
    }
    this.stopTicker()
    this.setState({ pending: '', message: '', phase: 'idle', elapsed: 0 })
    if (inFlight !== undefined) {
      void inFlight.then(async () => {
        const reconciled = await this.refresh()
        if (reconciled?.gate !== 'unknown') return
        this.feedback(this.t(reconciled.capabilities == null ? 'unknownOutcomeLocal' : 'unknownOutcome', {
          detail: this.t('failure.cancelled'),
        }))
      })
    }
  }

  /** Insert the transcript the draft refused earlier. */
  insertPending(): boolean {
    const pending = this.snapshot.pending
    if (pending === '') return false
    if (!this.take().inputActions.insertText(pending, this.take().inputActions.captureInsertion())) return false
    this.setState({ pending: '', message: '', phase: 'idle' })
    return true
  }

  /** Clear an unproven outcome the host still holds. */
  async acknowledgeUnknown(): Promise<void> {
    if (this.view === undefined || this.snapshot.ackBusy) return
    this.setState({ ackBusy: true })
    // A result may arrive after the user has started recording again; reporting it must not
    // collapse the row then, or the stop button of a live microphone disappears with it.
    const report = (text: string, kind: MessageKind = 'error'): void => {
      // An owned capture keeps its phase: feedback would hide the transcribing indicator and
      // offer a retry that `start` refuses because the capture is still in flight.
      if (this.active !== undefined) this.show(text, kind)
      else this.feedback(text, kind)
    }
    // A null id means the stored record could not be read at all; the Host accepts it
    // only as the user's explicit assertion that nothing of theirs is outstanding.
    try {
      const result = await this.take().injected.acknowledge({ operationId: this.view.pendingOperationId })
      if (result.ok && result.pendingOperationId !== null) {
        // The host accepted the request but something else still holds the gate.
        await this.refresh()
        report(this.t('gateBusy'), 'warn')
        return
      }
      if (!result.ok) {
        // A refusal can carry the id this host discovered on a re-read; refresh before
        // reporting so a second attempt sends that id instead of a stale null.
        await this.refresh()
        report(result.failure === null ? this.t('failure.internal') : failureText(this.t, result.failure))
        return
      }
      await this.refresh()
      // A recording may have started while this assertion was in flight. Only a live capture
      // is a reason to keep the control expanded: an attempt that aborted without recording
      // (a still-closed gate) must not swallow the acknowledgement's own success.
      if (this.active !== undefined) {
        this.show(this.t('acknowledged'), 'success')
        return
      }
      this.setState({ pending: '' })
      this.show(this.t('acknowledged'), 'success')
      this.setState({ phase: 'idle' })
    } catch {
      report(this.t('failure.internal'))
    } finally {
      this.setState({ ackBusy: false })
    }
  }

  private take(): { injected: SpeechRailInjected; inputActions: InputActions } {
    if (this.faces === undefined) throw new Error('speechrail control used before it was bound')
    return this.faces
  }

  /**
   * Localized message text.
   *
   * An arrow property, not a method: `failureText` and the message helpers take this function and call
   * it unbound, which a prototype method cannot survive.
   */
  private readonly t = (key: string, values?: Record<string, unknown>): string => {
    if (this.translate === undefined) return key
    return this.translate(key, values)
  }

  private captureText(error: unknown): string {
    if (error instanceof RecordingError) return this.t(`capture.${error.kind}`)
    return this.t('failure.internal')
  }

  private show(text: string, kind: MessageKind = 'error'): void {
    this.setState({ message: text, messageKind: kind })
  }

  private feedback(text: string, kind: MessageKind = 'error'): void {
    this.setState({ message: text, messageKind: kind, phase: 'feedback' })
  }

  private async refresh(): Promise<SpeechRailInputStatus | undefined> {
    const seq = ++this.statusSeq
    try {
      const next = await this.take().injected.status()
      // A read issued before one that already landed must not overwrite the newer view.
      // This does not cover a newer request that the host answers with an older snapshot:
      // `revision` tracks settings, not the gate, so the client cannot order two responses by
      // content. See "Known limitations" in README.md.
      if (seq < this.statusSeq) return this.view
      this.view = next
      this.setState({
        gate: next.gate,
        pendingOperationId: next.pendingOperationId,
        unprovenFailure: next.unprovenFailure,
        // The hint the snapshot in force puts on the wire, shown while its upload is transcribed.
        languageHint: next.languageHint,
      })
      return next
    } catch {
      return undefined
    }
  }

  private startTicker(): void {
    this.stopTicker()
    const startedAt = Date.now()
    this.ticker = setInterval(() => { this.setState({ elapsed: Math.floor((Date.now() - startedAt) / 1000) }) }, 1000)
  }

  private stopTicker(): void {
    if (this.ticker !== undefined) { clearInterval(this.ticker); this.ticker = undefined }
  }

  private setState(patch: Partial<ControlSnapshot>): void {
    const next = { ...this.snapshot, ...patch }
    // Leaving the recording phase drops both things that only a live take has.
    if (next.phase !== 'recording') { next.elapsed = 0; next.capture = undefined }
    const same = (Object.keys(next) as (keyof ControlSnapshot)[]).every((key) => next[key] === this.snapshot[key])
    if (same) return
    this.snapshot = next
    for (const listener of this.listeners) listener()
  }
}

/**
 * A control owned by one component's lifetime.
 *
 * The two slots share the controller the plugin creates; this is for the case where both halves render
 * inside one tree (the combined view, and the tests), so state starts and ends with that tree.
 * @returns the control.
 */
export function useOwnControl(): SpeechRailControl {
  const [control] = useState(() => new SpeechRailControl())
  useEffect(() => () => { control.dispose() }, [control])
  return control
}

/**
 * Read the control, hand it this half's faces, and return what to draw.
 *
 * Binding happens after every render: the faces are plain object identities, compared inside, so a
 * phase change never rebuilds the dictation subscription, and a new Session facade is adopted without
 * resetting a take that is still running. A press can only happen once mounted, so the faces are always
 * in place by then.
 * @param control - the shared control.
 * @param props - this half's seat props.
 * @returns the raw state the view draws.
 */
export function useControl(control: SpeechRailControl, props: SpeechRailSeatProps): ControlSnapshot {
  const { inputActions, status, check, configure, acknowledge, transcribe, createRecording, dictation, t } = props
  const injected: SpeechRailInjected = { status, check, configure, acknowledge, transcribe, createRecording, dictation }
  const translate = t as unknown as Translate
  useEffect(() => { control.bind(injected, inputActions, translate) })
  return useSyncExternalStore(control.subscribe, control.getSnapshot, control.getSnapshot)
}
