/** Live microphone level bars: a strip beside a capture, or the control that ends it. */
import { useEffect, useState } from 'react'
import type { Recording } from './recording.ts'

/** Number of retained level samples, one per bar of the widest strip. */
const BARS = 24

/**
 * Render a rolling RMS level display for one recording.
 * @param props - recording owner, accessible label, and the strip's shape.
 * @returns the bar strip.
 */
export function Waveform({ recording, label, bars = BARS, height = 16, color = 'var(--dsw-alias-label-secondary, #8a8a8e)' }: {
  readonly recording: Recording | undefined
  readonly label: string
  /** How many bars to draw; the newest samples are kept. */
  readonly bars?: number
  /** Strip height in pixels. */
  readonly height?: number
  /** Bar colour; `currentColor` follows the control that holds the strip. */
  readonly color?: string
}) {
  const [levels, setLevels] = useState<readonly number[]>(() => new Array<number>(BARS).fill(0))
  useEffect(() => {
    const timer = setInterval(() => {
      const level = Math.min(1, (recording?.amplitude() ?? 0) * 4)
      setLevels((previous) => [...previous.slice(1), level])
    }, 80)
    return () => { clearInterval(timer) }
  }, [recording])
  // The sampling window keeps its full width whatever the caller draws, so a narrow strip shows the
  // newest samples rather than a shorter history.
  const shown = [...new Array<number>(Math.max(0, bars - levels.length)).fill(0), ...levels].slice(-bars)
  return (
    <span role="img" aria-label={label} style={{ display: 'inline-flex', alignItems: 'flex-end', gap: 1, height }}>
      {shown.map((level, index) => (
        <span
          key={index}
          style={{
            width: 2,
            height: `${Math.round(Math.max(0.08, level) * 100)}%`,
            background: color,
            borderRadius: 1,
          }}
        />
      ))}
    </span>
  )
}
