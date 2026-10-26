/**
 * The reporting half of the composer control: everything a press produces, before the model selector.
 *
 * The button lives in another seat, after the model selector, so a live take never moves it. What is
 * left here is the information and the two recovery actions: how long the take has run, which phase it
 * is in, the cancel control, the message, and the transcript a refused draft still owes the user.
 * @module dsh-voice-input/client/VoicePanel
 */

import type { CSSProperties, ReactNode } from 'react'
import type { ControlSnapshot, LocaleText, MessageKind, SpeechRailControl } from './control.ts'
import { failureText } from './failure-text.ts'
import { RowButton } from './RowButton.tsx'
import { isWaiting, phaseLabel } from './VoiceAnchor.tsx'

const closeStyle: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22,
  borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--dsw-alias-border-l2, #b4b4bb)', borderRadius: 11,
  color: 'var(--dsw-alias-label-primary, inherit)', padding: 0,
  // The cancel glyph is a character, so it needs the type size the buttons' labels get from padding.
  fontSize: 13, lineHeight: 1,
}

const inlineStyle: CSSProperties = {
  fontSize: 12, padding: '2px 8px', borderRadius: 6, whiteSpace: 'nowrap',
  borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--dsw-alias-border-l2, #b4b4bb)',
  color: 'var(--dsw-alias-label-primary, inherit)',
}

/** The live take's elapsed time: a fixed width so the row does not twitch every second. */
const timerStyle: CSSProperties = {
  fontSize: 12, minWidth: 30, fontVariantNumeric: 'tabular-nums',
  color: 'var(--dsw-alias-label-secondary, #8a8a8e)',
}

const messageStyle: CSSProperties = {
  fontSize: 12, maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
}

/** Declared theme tokens only; each carries a light and a dark value. */
const MESSAGE_COLOR: Record<MessageKind, string> = {
  info: 'var(--dsw-alias-label-secondary, #8a8a8e)',
  warn: 'var(--dsw-alias-state-warn-primary, #a06a00)',
  error: 'var(--dsw-alias-state-error-primary, #d3574a)',
  success: 'var(--dsw-alias-state-success-primary, #2e7d32)',
}

/** Whole seconds a take has run, as the `m:ss` a person reads. */
function formatElapsed(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/**
 * Draw the reporting half.
 * @param props - the shared control, its snapshot and the locale.
 * @returns the panel's elements.
 */
export function VoicePanelView({ control, snapshot, t }: {
  readonly control: SpeechRailControl
  readonly snapshot: ControlSnapshot
  readonly t: LocaleText
}): ReactNode {
  const { phase, message, messageKind, pending, elapsed, gate, languageHint, ackBusy, unprovenFailure } = snapshot
  const waiting = isWaiting(phase)
  const phaseText = phaseLabel(phase, t)

  /** One message line, coloured by what it says. */
  const messageLine = (text: string, kind: MessageKind, title: string): ReactNode => (
    <span role="status" data-voice-input-message={kind} style={{ ...messageStyle, color: MESSAGE_COLOR[kind] }} title={title}>{text}</span>
  )

  return (
    <>
      {phase === 'recording' && (
        // The service caps a take, and the running time is the one number worth having while dictating.
        <span role="timer" data-voice-input-elapsed={elapsed} style={timerStyle}>{formatElapsed(elapsed)}</span>
      )}
      {phase !== 'idle' && (
        <RowButton
          label={t(pending === '' ? 'cancel' : 'discard')}
          onClick={() => { control.cancel() }}
          style={closeStyle}
        >×</RowButton>
      )}
      {waiting && (
        <span role="status" data-voice-input-message="info" style={{ ...messageStyle, color: MESSAGE_COLOR.info }} title={phaseText}>
          <span>{phaseText}</span>
          {phase === 'transcribing' && languageHint !== '' && (
            // The hint the snapshot in force puts on the wire. The host decides it again when
            // the upload starts, so this is the reported value, not a promise about bytes: what
            // it is worth saying is which language is in force while dictating, since the
            // settings page is not on screen.
            <> · <span>{t('languageHintInline', { language: languageHint })}</span></>
          )}
        </span>
      )}
      {(waiting || phase === 'recording') && message !== '' && (
        // A result that arrived while this take is still running has nowhere else to go: the button
        // keeps its own role, so the message sits here with its own colour.
        messageLine(message, messageKind, message)
      )}
      {phase === 'feedback' && (
        <>
          {messageLine(message, messageKind, pending === '' ? message : pending)}
          {pending !== '' && (
            <RowButton
              label={t('insert')}
              title={t('insert')}
              onClick={() => { control.insertPending() }}
              style={inlineStyle}
            >{t('insert')}</RowButton>
          )}
        </>
      )}
      {gate === 'unknown' && (
        // Never disabled by this control's own phase: clearing an unproven outcome is recovery, and a
        // recording that ends badly must not leave the gate with no way out.
        <RowButton
          label={t('acknowledge')}
          title={t('acknowledge')}
          disabled={ackBusy}
          onClick={() => { void control.acknowledgeUnknown() }}
          style={inlineStyle}
        >{t('acknowledge')}</RowButton>
      )}
      {phase === 'idle' && message !== '' && messageLine(message, messageKind, message)}
      {phase === 'idle' && message === '' && gate === 'unknown' && messageLine(
        // The host keeps the failure that left this attempt unproven, so the cause survives a page
        // reload even though this control's own record of the attempt does not. Without it the row can
        // only say that something is unconfirmed.
        unprovenFailure === null || unprovenFailure === undefined
          ? t('gateUnknown')
          : `${t('gateUnknown')} ${failureText(t, unprovenFailure)}`,
        'warn',
        unprovenFailure === null || unprovenFailure === undefined
          ? t('gateUnknown')
          : `${t('gateUnknown')} ${failureText(t, unprovenFailure)}`,
      )}
    </>
  )
}
