/**
 * Journal mutation safety.
 *
 * `clear` and `reset` are the only ways a durable record disappears; both must refuse to
 * erase a record that appeared after their caller decided.
 */

import { describe, expect, it } from 'vitest'
import { journalFromUnit } from '../src/host/journal.ts'

/** A unit whose global value the test can inspect and disturb. */
function unit(initial: unknown = null): { readonly journal: ReturnType<typeof journalFromUnit>, read: () => unknown, write: (value: unknown) => void } {
  let stored: unknown = initial
  return {
    journal: journalFromUnit({
      readGlobal: async () => stored,
      writeGlobal: async (value) => { stored = value },
    }),
    read: () => stored,
    write: (value) => { stored = value },
  }
}

describe('journal mutations', () => {
  it('refuses to erase a record written since the caller decided', async () => {
    const { journal, read } = unit()
    await journal.record({ operationId: 'op_aaaaaaaa', phase: 'pending', createdAt: '2026-10-23T12:00:00.000Z' })

    expect(await journal.reset()).toBe(false)
    expect(read()).not.toBeNull()
  })

  it('still erases unreadable bytes, which is what the reset exists for', async () => {
    const { journal, read } = unit('{not json')

    expect(await journal.reset()).toBe(true)
    expect(read()).toBeNull()
  })

  it('refuses to clear a different operation and clears the matching one', async () => {
    const { journal, read } = unit()
    await journal.record({ operationId: 'op_aaaaaaaa', phase: 'pending', createdAt: '2026-10-23T12:00:00.000Z' })

    expect(await journal.clear('op_bbbbbbbb')).toBe(false)
    expect(read()).not.toBeNull()
    expect(await journal.clear('op_aaaaaaaa')).toBe(true)
    expect(read()).toBeNull()
  })
})
