/**
 * Every colour this bundle asks for must be a token the Harness declares.
 *
 * The declared set below is what the live Client `Theme.listTokens` inspection reported on 2026-10-26:
 * fourteen names, each with a light and a dark value. A name outside that set may still resolve, but
 * nothing promises it - and the hardcoded fallback beside it then becomes the colour in every theme,
 * which is how a light-theme grey ends up painted on a dark surface.
 *
 * `backgroundColor` is deliberately not asserted anywhere: jsdom's CSS engine drops a `var()` value for
 * that longhand (measured 2026-10-26), so the components use `background` and the tests can read it.
 */

import { readdir, readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

/** Names the Harness declares for both themes. */
const DECLARED = new Set([
  '--dsw-alias-bg-base',
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-bg-layer-2',
  '--dsw-alias-bg-overlay',
  '--dsw-alias-border-l1',
  '--dsw-alias-border-l2',
  '--dsw-alias-brand-primary',
  '--dsw-alias-label-primary',
  '--dsw-alias-label-secondary',
  '--dsw-alias-state-error-primary',
  '--dsw-alias-state-idle-primary',
  '--dsw-alias-state-success-primary',
  '--dsw-alias-state-warn-primary',
  '--dsw-specific-sidebar-fill',
])

const CLIENT = new URL('../src/client/', import.meta.url)

describe('client theme tokens', () => {
  it('asks for no colour the Harness does not declare', async () => {
    const files = (await readdir(CLIENT)).filter((name) => name.endsWith('.ts') || name.endsWith('.tsx'))
    expect(files.length).toBeGreaterThan(5)

    const undeclared = new Map<string, string>()
    for (const file of files) {
      const source = await readFile(new URL(file, CLIENT), 'utf8')
      for (const match of source.matchAll(/--dsw-[a-z0-9-]+/g)) {
        const name = match[0]
        if (!DECLARED.has(name)) undeclared.set(name, file)
      }
    }

    expect([...undeclared.entries()]).toEqual([])
  })
})
