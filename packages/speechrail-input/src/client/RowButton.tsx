/**
 * The one button shape this bundle draws.
 * @module @hrygo/dsh-speechrail-bundle/client/RowButton
 */

import { useState, type CSSProperties, type ReactNode } from 'react'

import { prefersReducedMotion } from './motion.ts'

/**
 * One compact control: a 28px composer button or a settings action, sharing one behaviour.
 *
 * The bundle ships no stylesheet, so every control needs the three things one would otherwise give it:
 * a surface under the pointer, a visible focus ring, and dimming while it refuses interaction. The one
 * exception is a control whose glyph is itself the report of work in progress: dimming that to 55%
 * makes the only thing worth looking at the hardest thing to see, so it stays at full contrast and
 * refuses the press instead. The composer's recording anchor also keeps the draft focused instead of
 * taking the caret out of it.
 * @param props - accessible name, tooltip, interaction flags, busy glyph, geometry, and content.
 * @returns the button.
 */
export function RowButton({ label, title, disabled = false, keepFocus = false, busy = false, onClick, style, children }: {
  readonly label: string
  readonly title?: string
  readonly disabled?: boolean
  readonly keepFocus?: boolean
  /** The glyph reports work in progress, so it keeps full contrast while the press is refused. */
  readonly busy?: boolean
  readonly onClick: () => void
  readonly style: CSSProperties
  readonly children: ReactNode
}) {
  const [hover, setHover] = useState(false)
  const [focus, setFocus] = useState(false)
  const still = prefersReducedMotion()
  return (
    <button
      type="button"
      aria-label={label}
      title={title}
      disabled={disabled}
      onMouseDown={(event) => { if (keepFocus) event.preventDefault() }}
      onMouseEnter={() => { setHover(true) }}
      onMouseLeave={() => { setHover(false) }}
      onFocus={() => { setFocus(true) }}
      onBlur={() => { setFocus(false) }}
      onClick={onClick}
      style={{
        background: hover && !disabled ? 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.12))' : 'transparent',
        // The surface arrives under the pointer instead of appearing: 120ms is long enough to read as
        // a fade and short enough not to lag a click.
        transition: still ? undefined : 'background 120ms ease, opacity 120ms ease',
        outline: focus ? '2px solid var(--dsw-alias-brand-primary, #4a7dff)' : 'none',
        outlineOffset: 2,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled && !busy ? 0.55 : 1,
        ...style,
      }}
    >
      {children}
    </button>
  )
}

