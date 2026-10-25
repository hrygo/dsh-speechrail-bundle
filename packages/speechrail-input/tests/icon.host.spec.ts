/**
 * The plugin icon has to survive both themes and both embeddings.
 *
 * A glyph drawn with `currentColor` is the trap: if the Harness inlines the SVG it inherits the card's
 * text colour and looks right, but if it loads it as an image - the form the market listing uses - then
 * `currentColor` has no inherited value and paints near-black, which is invisible on a dark card. This
 * icon is therefore self-contained: its own tile, its own colours, no media queries (the app's theme
 * switch need not follow the system's), and a measured contrast ratio inside it.
 */

import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const ICON = new URL('../icon.svg', import.meta.url)

/** Linearise one sRGB channel. */
function linear(channel: number): number {
  const value = channel / 255
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

/** WCAG relative luminance of a `#rrggbb` colour. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((offset) => linear(Number.parseInt(hex.slice(offset, offset + 2), 16)))
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}

/** WCAG contrast ratio between two opaque colours. */
function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((left, right) => right - left)
  return (light! + 0.05) / (dark! + 0.05)
}

/** The file's markup, without the comments that explain it. */
function markup(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, '')
}

/** Every colour the file paints with, in document order. */
function colours(source: string): string[] {
  return [...source.matchAll(/#[0-9a-fA-F]{6}/g)].map((match) => match[0].toLowerCase())
}

describe('plugin icon', () => {
  it('draws its own tile instead of inheriting a colour', async () => {
    const source = markup(await readFile(ICON, 'utf8'))

    expect(source).toContain('viewBox="0 0 64 64"')
    expect(source).not.toContain('currentColor')
    // The app's light/dark switch is not the system's, so a media query here would answer the wrong
    // question - and silently, in the wrong theme.
    expect(source).not.toContain('prefers-color-scheme')
    // An `<img>` embedding cannot inherit anything, so every painted node names its colour.
    expect(colours(source).length).toBeGreaterThanOrEqual(2)
  })

  it('keeps the glyph readable on its tile, and the tile visible on either page', async () => {
    const palette = colours(markup(await readFile(ICON, 'utf8')))
    const tile = palette[0]!
    const glyph = palette.find((colour) => luminance(colour) > luminance(tile))!

    // Inside the icon: a glyph that reads as text, not decoration.
    expect(contrast(glyph, tile)).toBeGreaterThanOrEqual(4.5)
    // Against the two page surfaces an icon can land on: both edges stay perceivable (3:1 is the
    // non-text threshold).
    expect(contrast(tile, '#ffffff')).toBeGreaterThanOrEqual(3)
    expect(contrast(tile, '#16181a')).toBeGreaterThanOrEqual(3)
  })
})
