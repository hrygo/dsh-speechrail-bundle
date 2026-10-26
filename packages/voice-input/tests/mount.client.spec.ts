/**
 * The seats the control occupies, and the wiring around them.
 *
 * Where the control sits is product behaviour rather than an implementation detail, and it is now two
 * places: the round button registers in the composer's activity seat - a compact action rendered after
 * the model selector, which is where the user asked for it - and everything a press produces registers
 * in the `conversation.input.right` list, whose entries render inside the model selector's own group,
 * immediately before it. An earlier version had the whole control in the activity seat; the composer
 * hides its ordinary accessory controls while an activity reports itself expanded, which slid the tool
 * row away from the click, so the button half never reports expansion.
 */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { mountSpeechRailInput } from '../src/client/mount.ts'

/** One recorded slot registration, as much of it as these cases assert on. */
interface Seat {
  readonly name: string
  readonly id?: string
  readonly order?: number
  readonly key?: string
}

/** An awaitable disposer shaped like the one `ctx.inject` returns. */
function injection(): Promise<void> & { dispose: () => Promise<void> } {
  const promise = Promise.resolve() as Promise<void> & { dispose: () => Promise<void> }
  promise.dispose = async () => undefined
  return promise
}

/**
 * A Context stub that records what the bundle registers.
 * @returns the context, the recorded seats, the slot keys it targeted, and the services it asked for.
 */
function fakeContext(): { ctx: Context, seats: Seat[], targeted: string[], injected: string[] } {
  const seats: Seat[] = []
  const targeted: string[] = []
  const injected: string[] = []
  const self = {
    effect: (fn: () => unknown): (() => void) => {
      const result = fn()
      return () => { if (typeof result === 'function') (result as () => void)() }
    },
    locale: { register: () => () => undefined, bind: () => () => 'text' },
    remote: { $mount: async () => async () => undefined, speechrailInput: {} },
    slots: {
      register: (options: Seat): (() => void) => { seats.push(options); return () => undefined },
      // The real service runs the callback once the slot is declared. Declaring every key here is what
      // keeps the stub honest: a registration into a seat this bundle must not touch is recorded and
      // caught by the assertions below rather than silently dropped.
      inject: (name: string, callback: () => unknown): (() => void) => {
        targeted.push(name)
        callback()
        return () => undefined
      },
    },
  }
  // A child context keeps `inject`, because the service-scoped context the real one hands to a
  // composition can inject further services (the keyboard registry is one).
  const ctx = {
    ...self,
    inject: (names: readonly string[], callback: (context: unknown) => unknown): Promise<void> & { dispose: () => Promise<void> } => {
      injected.push(...names)
      // The optional keyboard service is left absent on purpose: a composition without it must keep a
      // working microphone. `command.client.spec.ts` covers the path where it is installed.
      if (!names.includes('shortcuts')) callback(ctx)
      return injection()
    },
  }
  return { ctx: ctx as unknown as Context, seats, targeted, injected }
}

describe('SpeechRail composer seats', () => {
  it('puts the button after the model selector', async () => {
    const { ctx, seats } = fakeContext()
    await mountSpeechRailInput(ctx, {} as never)

    // A single seat, so it is chosen by priority and carries no cell id.
    const button = seats.find((candidate) => candidate.name === 'conversation.input.activity')
    expect(button).toBeDefined()
    expect(button?.id).toBeUndefined()
  })

  it('keeps what a press produces before the model selector', async () => {
    const { ctx, seats } = fakeContext()
    await mountSpeechRailInput(ctx, {} as never)

    const panel = seats.find((candidate) => candidate.name === 'conversation.input.right')
    expect(panel).toEqual(expect.objectContaining({ id: 'voice-input-panel', order: 20 }))
    // The shipped control in that slot is ordered 10, so a larger order is what puts this one between
    // it and the model selector rather than at the far end of the group.
    expect(panel?.order).toBeGreaterThan(10)
  })

  it('targets those two seats and the settings page, and nothing else', async () => {
    const { ctx, targeted } = fakeContext()
    await mountSpeechRailInput(ctx, {} as never)

    expect(targeted).toEqual(['conversation.input.activity', 'conversation.input.right', 'plugins.bundle.config'])
  })

  it('registers the settings page and asks for the keyboard service', async () => {
    const { ctx, seats, injected } = fakeContext()
    await mountSpeechRailInput(ctx, {} as never)

    expect(seats).toContainEqual(expect.objectContaining({ name: 'plugins.bundle.config', key: 'dsh-voice-input' }))
    expect(injected).toContain('shortcuts')
  })
})
