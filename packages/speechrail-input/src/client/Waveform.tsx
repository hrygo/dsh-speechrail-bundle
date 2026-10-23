/** Live microphone level bars for the expanded recording row. */
import { useEffect, useState } from 'react'
import type { Recording } from './recording.ts'

/** Number of retained level samples, one per bar. */
const BARS = 24

/**
 * Render a rolling RMS level display for one recording.
 * @param props - recording owner and accessible label.
 * @returns the bar strip.
 */
export function Waveform({ recording, label }: { readonly recording: Recording | undefined, readonly label: string }) {
  const [levels, setLevels] = useState<readonly number[]>(() => new Array<number>(BARS).fill(0))
  useEffect(() => {
    const timer = setInterval(() => {
      const level = Math.min(1, (recording?.amplitude() ?? 0) * 4)
      setLevels((previous) => [...previous.slice(1), level])
    }, 80)
    return () => { clearInterval(timer) }
  }, [recording])
  return (
    <span role="img" aria-label={label} style={{ display: 'inline-flex', alignItems: 'flex-end', gap: 1, height: 16 }}>
      {levels.map((level, index) => (
        <span
          key={index}
          style={{
            width: 2,
            height: `${Math.round(Math.max(0.08, level) * 100)}%`,
            background: 'var(--dsw-alias-content-secondary, #8a8a8e)',
            borderRadius: 1,
          }}
        />
      ))}
    </span>
  )
}
