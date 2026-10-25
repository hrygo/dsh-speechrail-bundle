/**
 * The button half of the composer control: one round control, after the model selector.
 *
 * It keeps its place and its size through every phase. This seat can be occupied by a control that
 * expands across the toolbar, and the composer hides its ordinary accessory controls while one is
 * expanded - so this half never reports itself expanded, and everything a press produces is drawn by
 * the other half, in the control group before the model selector.
 * @module @hrygo/dsh-speechrail-bundle/client/VoiceAnchor
 */

import type { ReactNode } from 'react'
import type { ControlSnapshot, LocaleText, SpeechRailControl } from './control.ts'
import { prefersReducedMotion } from './motion.ts'
import { RowButton } from './RowButton.tsx'
import { Waveform } from './Waveform.tsx'

/** Geometry of the round control, in every phase. */
const triggerStyle = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28,
  borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--dsw-alias-border-l2, #b4b4bb)', borderRadius: 14,
  color: 'var(--dsw-alias-label-primary, inherit)', padding: 0,
} as const

/** The microphone: the control's resting glyph. */
const MICROPHONE = (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <path
      d="M8 1.5a2.5 2.5 0 0 0-2.5 2.5v4a2.5 2.5 0 0 0 5 0V4A2.5 2.5 0 0 0 8 1.5Zm-4.5 6a.75.75 0 0 1 .75.75 3.75 3.75 0 0 0 7.5 0 .75.75 0 0 1 1.5 0 5.25 5.25 0 0 1-4.5 5.2v1.3h1.75a.75.75 0 0 1 0 1.5h-5a.75.75 0 0 1 0-1.5H7.25v-1.3a5.25 5.25 0 0 1-4.5-5.2A.75.75 0 0 1 3.5 7.5Z"
      fill="currentColor"
    />
  </svg>
)

/**
 * The waiting phases share one label and one ring, at the microphone's own 16px.
 *
 * SMIL rather than a keyframe class: the bundle ships no stylesheet, and this animation belongs to the
 * work being reported. With motion unwelcome the same ring is drawn without the rotation, so the phase
 * still has a glyph that is not the microphone nobody can press.
 * @param label - the phase's own name.
 * @param animated - whether to rotate the arc.
 * @returns the indicator.
 */
const SPINNER = (label: string, animated: boolean): ReactNode => (
  <svg width="16" height="16" viewBox="0 0 16 16" role="img" aria-label={label} focusable="false">
    <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.25" />
    <path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      {animated && <animateTransform attributeName="transform" type="rotate" from="0 8 8" to="360 8 8" dur="0.9s" repeatCount="indefinite" />}
    </path>
  </svg>
)

/** Whether a phase is work in progress rather than a recording or a resting control. */
export function isWaiting(phase: ControlSnapshot['phase']): boolean {
  return phase === 'checking' || phase === 'requesting' || phase === 'transcribing'
}

/** The localized name of a waiting phase. */
export function phaseLabel(phase: ControlSnapshot['phase'], t: LocaleText): string {
  return phase === 'transcribing' ? t('transcribingShort') : phase === 'checking' ? t('checking') : t('requesting')
}

/**
 * Draw the round control.
 * @param props - the shared control, its snapshot and the locale.
 * @returns the button.
 */
export function VoiceAnchorView({ control, snapshot, t }: {
  readonly control: SpeechRailControl
  readonly snapshot: ControlSnapshot
  readonly t: LocaleText
}): ReactNode {
  const { phase } = snapshot
  if (phase === 'recording') {
    return (
      <RowButton
        label={t('stop')}
        title={t('stop')}
        keepFocus
        onClick={() => { void control.finish() }}
        style={{
          ...triggerStyle, flex: 'none',
          color: 'var(--dsw-alias-state-error-primary, #d3574a)',
          borderColor: 'var(--dsw-alias-state-error-primary, #d3574a)',
        }}
      >
        <Waveform recording={snapshot.capture} label={t('recording')} bars={5} height={14} color="currentColor" />
      </RowButton>
    )
  }
  const waiting = isWaiting(phase)
  const label = waiting ? phaseLabel(phase, t) : phase === 'feedback' ? t('retryRecording') : t('start')
  return (
    <RowButton
      label={label}
      title={phase === 'feedback' ? t('retryRecording') : t('dictate')}
      disabled={waiting}
      // A progress glyph is content, not a dimmed control: at reduced opacity it would be barely there.
      busy={waiting}
      // The composer keeps the caret: pressing the microphone must not move focus out of the draft.
      keepFocus
      onClick={() => { void control.start() }}
      style={{ ...triggerStyle, flex: 'none' }}
    >
      {waiting ? SPINNER(label, !prefersReducedMotion()) : MICROPHONE}
    </RowButton>
  )
}
