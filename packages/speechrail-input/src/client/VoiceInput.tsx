/**
 * The composer microphone: one control, drawn by two slots.
 *
 * The button is registered after the model selector and the reporting half inside the model selector's
 * own control group, before it - so this module exports both seats, plus the combined view that draws
 * them in one row for the tests and for any single-seat embedding. The state they share lives in
 * {@link ./control.ts}.
 * @module @hrygo/dsh-speechrail-bundle/client/VoiceInput
 */

import type { ReactNode } from 'react'
import { useControl, useOwnControl, type SpeechRailControl, type SpeechRailSeatProps } from './control.ts'
import { rowStyle } from './row.ts'
import { VoiceAnchorView } from './VoiceAnchor.tsx'
import { VoicePanelView } from './VoicePanel.tsx'

export type {
  SpeechRailActions,
  SpeechRailInjected,
  SpeechRailSeatProps,
  VoiceInputProps,
} from './control.ts'

/**
 * Both halves in one row.
 * @param props - this Session's seat props.
 * @returns the row the tests and any single-seat embedding see.
 */
export function VoiceInput(props: SpeechRailSeatProps): ReactNode {
  const control = useOwnControl()
  const snapshot = useControl(control, props)
  return (
    <div style={rowStyle} data-speechrail-activity={snapshot.phase}>
      <VoiceAnchorView control={control} snapshot={snapshot} t={props.t} />
      <VoicePanelView control={control} snapshot={snapshot} t={props.t} />
    </div>
  )
}

/**
 * The button's own seat: after the model selector, where the composer expects a compact action.
 *
 * It never reports itself expanded, so the composer keeps its ordinary accessory controls - including
 * the other half of this control - on screen.
 * @param control - the control the plugin owns.
 * @returns the seat component.
 */
export function createAnchorSeat(control: SpeechRailControl): (props: SpeechRailSeatProps) => ReactNode {
  /**
   * @param props - this Session's seat props.
   * @returns the button's row.
   */
  return function VoiceAnchorSeat(props: SpeechRailSeatProps): ReactNode {
    const snapshot = useControl(control, props)
    return (
      <div style={rowStyle} data-speechrail-activity={snapshot.phase} data-speechrail-half="anchor">
        <VoiceAnchorView control={control} snapshot={snapshot} t={props.t} />
      </div>
    )
  }
}

/**
 * The reporting seat: the model selector's control group, immediately before it.
 * @param control - the control the plugin owns.
 * @returns the seat component.
 */
export function createPanelSeat(control: SpeechRailControl): (props: SpeechRailSeatProps) => ReactNode {
  /**
   * @param props - this Session's seat props.
   * @returns the panel's row.
   */
  return function VoicePanelSeat(props: SpeechRailSeatProps): ReactNode {
    const snapshot = useControl(control, props)
    return (
      <div style={rowStyle} data-speechrail-activity={snapshot.phase} data-speechrail-half="panel">
        <VoicePanelView control={control} snapshot={snapshot} t={props.t} />
      </div>
    )
  }
}
