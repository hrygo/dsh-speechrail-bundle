/**
 * Geometry shared by the two halves of the composer control.
 * @module dsh-voice-input/client/row
 */

import type { CSSProperties } from 'react'

/**
 * One compact row.
 *
 * The button and what a press produces are drawn in two different seats, so each renders its own row;
 * the combined view renders them inside one, which is what keeps the button's place and size fixed.
 */
export const rowStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, flex: 'none', minWidth: 0, maxWidth: '100%' }
