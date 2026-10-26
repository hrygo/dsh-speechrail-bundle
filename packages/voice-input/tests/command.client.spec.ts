/**
 * The dictation command under test: its identity must be stable across releases (the shortcuts
 * registry keys stored preferences by it) and its two resolutions must match what the mounted
 * control would really do.
 */

import { describe, expect, it, vi } from 'vitest'
import { DICTATE_COMMAND_ID, createDictateCommand, registerDictateCommand } from '../src/client/command.ts'
import { createDictationTrigger } from '../src/client/trigger.ts'

const t = (key: string): string => key

/** The registry sees this context for every press in these tests. */
const CONTEXT = { region: 'editable', modal: null, target: null } as const

describe('dictate command', () => {
  it('keeps one stable identity and a localizable label', () => {
    const command = createDictateCommand(t, createDictationTrigger())
    expect(command.id).toBe('voice-input.dictate')
    expect(command.id).toBe(DICTATE_COMMAND_ID)
    expect(command.label()).toBe('shortcut.dictate')
    expect(command.aliases).toEqual([])
  })

  it('defaults to a chord outside every key the composer already owns, in every profile', () => {
    const command = createDictateCommand(t, createDictationTrigger())
    expect(Object.keys(command.defaults).sort()).toEqual([
      'desktop:linux', 'desktop:macos', 'desktop:windows',
      'web:linux', 'web:macos', 'web:windows',
    ])
    for (const binding of Object.values(command.defaults)) {
      expect(binding).toEqual({ code: 'Space', modifiers: ['primary', 'shift'] })
    }
    expect(command.regions).toEqual(['page', 'editable'])
    expect(command.modals).toEqual([])
  })

  it('blocks with a localized reason while nothing is mounted to accept a toggle', () => {
    const resolution = createDictateCommand(t, createDictationTrigger()).resolve(CONTEXT)
    expect(resolution).toEqual({ status: 'blocked', reason: 'shortcut.unavailable' })
  })

  it('handles the press by asking the mounted control exactly once', () => {
    const trigger = createDictationTrigger()
    let toggles = 0
    const off = trigger.subscribe(() => { toggles += 1 })

    const resolution = createDictateCommand(t, trigger).resolve(CONTEXT)
    expect(resolution.status).toBe('handled')
    if (resolution.status !== 'handled') throw new Error('unreachable')
    resolution.run()
    expect(toggles).toBe(1)

    off()
  })

  it('degrades to no shortcut when the registry refuses the registration', () => {
    const refusing = { register: () => { throw new Error('overlapping default bindings') } }
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const dispose = registerDictateCommand(refusing, t, createDictationTrigger())

    expect(logged).toHaveBeenCalledTimes(1)
    expect(() => { dispose() }).not.toThrow()
    logged.mockRestore()
  })

  it('returns the registry disposer when the registration is accepted', () => {
    const released = vi.fn()
    const accepting = { register: () => released }

    registerDictateCommand(accepting, t, createDictationTrigger())()

    expect(released).toHaveBeenCalledTimes(1)
  })
})
