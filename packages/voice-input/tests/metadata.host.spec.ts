/**
 * The card a person sees in the plugin manager is built from files in this package, and its failure
 * mode is silent: with no readable display metadata the card still renders - as the bare install
 * spec, which for this plugin is a release URL. That happened in 2.0.0: `locale/*.json` still named
 * the old brand, and the card showed the tarball URL instead of a title and a sentence.
 *
 * The reader is `readPluginMeta` in `@deepseek-ai/dsh-app-boot`: `locale/en.json` (then the other
 * locale files beside it) supplies `meta.title` and `meta.description`, `package.json` supplies the
 * fallbacks, and `package.json` `icon` is inlined as a data URI when it is SVG, PNG, JPEG or WebP
 * under 256 KiB. Nothing about it is measured here - only the shape this package must keep, so a
 * later edit cannot quietly turn the card back into a URL.
 */

import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const LOCALES = ['en', 'zh'] as const

/** Read and parse one file of this package. */
async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), 'utf8')) as T
}

/** The fields the plugin manager reads out of a locale dictionary. */
interface LocaleFile {
  meta?: { title?: unknown; description?: unknown }
}

/** The fields the plugin manager reads out of the manifest. */
interface Manifest {
  name?: string
  description?: string
  icon?: string
  files?: string[]
}

describe.each(LOCALES)('locale/%s.json display metadata', (locale) => {
  it('names the plugin without the retired brand and without repeating the package name', async () => {
    const { meta } = await readJson<LocaleFile>(`locale/${locale}.json`)
    expect(typeof meta?.title, 'meta.title').toBe('string')
    const title = String(meta?.title)
    expect(title.trim()).not.toBe('')
    // "SpeechRail voice input" was the 1.x title: the plugin is engine-agnostic, so the brand of one
    // engine must not be what a person reads in the plugin list.
    expect(title).not.toMatch(/speechrail/i)
    expect(title).not.toMatch(/^dsh-/i)
    expect(title.length).toBeLessThanOrEqual(40)
  })

  it('describes what it does in one card line', async () => {
    const { meta } = await readJson<LocaleFile>(`locale/${locale}.json`)
    expect(typeof meta?.description, 'meta.description').toBe('string')
    const description = String(meta?.description)
    expect(description.trim()).not.toBe('')
    // The card wraps at roughly this width; a longer string is truncated rather than shown.
    expect(description.length).toBeGreaterThan(20)
    expect(description.length).toBeLessThanOrEqual(220)
    expect(description).not.toMatch(/speechrail/i)
  })
})

describe('manifest display metadata', () => {
  it('declares an icon that ships and that the reader can inline', async () => {
    const manifest = await readJson<Manifest>('package.json')
    expect(manifest.icon, 'package.json icon').toBeTypeOf('string')
    const icon = String(manifest.icon).replace(/^\.\//, '')
    expect(['svg', 'png', 'jpeg', 'jpg', 'webp']).toContain(icon.split('.').pop()?.toLowerCase())
    // A relative icon resolves against the manifest and is inlined; a file the release leaves out
    // would be an `icon` pointing at nothing.
    expect(manifest.files ?? []).toContain(icon)
    const bytes = await readFile(new URL(`../${icon}`, import.meta.url))
    expect(bytes.byteLength).toBeGreaterThan(0)
    expect(bytes.byteLength).toBeLessThanOrEqual(256 * 1024)
  })

  it('keeps a manifest description as the fallback for a missing locale dictionary', async () => {
    const manifest = await readJson<Manifest>('package.json')
    expect(manifest.description, 'package.json description').toBeTypeOf('string')
    expect(String(manifest.description).trim().length).toBeGreaterThan(40)
  })
})
