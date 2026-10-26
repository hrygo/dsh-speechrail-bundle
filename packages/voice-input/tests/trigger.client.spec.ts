/**
 * The trigger channel under test: it is the only thing a keyboard command and the composer
 * control share, so its availability answer has to match what the control would really do.
 */

import { describe, expect, it, vi } from 'vitest'
import { createDictationTrigger } from '../src/client/trigger.ts'

describe('dictation trigger', () => {
  it('is unavailable until a control subscribes', () => {
    const trigger = createDictationTrigger()
    expect(trigger.available()).toBe(false)
    const off = trigger.subscribe(() => undefined)
    expect(trigger.available()).toBe(true)
    off()
    expect(trigger.available()).toBe(false)
  })

  it('forwards a toggle to every subscriber and survives one that throws', () => {
    const trigger = createDictationTrigger()
    const seen = vi.fn()
    const failing = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const off = trigger.subscribe(() => { throw new Error('controller died') })
    const off2 = trigger.subscribe(seen)

    expect(() => { trigger.toggle() }).not.toThrow()
    expect(seen).toHaveBeenCalledTimes(1)
    expect(failing).toHaveBeenCalledTimes(1)

    off()
    off2()
    failing.mockRestore()
  })

  it('lets a handler unsubscribe itself while it runs', () => {
    const trigger = createDictationTrigger()
    const later = vi.fn()
    const off = trigger.subscribe(() => { off() })
    const off2 = trigger.subscribe(later)

    trigger.toggle()

    expect(trigger.available()).toBe(true)
    expect(later).toHaveBeenCalledTimes(1)
    expect(trigger.available()).toBe(true)
    off2()
    expect(trigger.available()).toBe(false)
  })
})
