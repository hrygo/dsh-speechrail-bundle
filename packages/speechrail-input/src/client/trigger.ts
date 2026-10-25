/**
 * The one channel between a keyboard command and the mounted composer control.
 *
 * The command is registered outside React, while the capture state machine lives inside a
 * component, so neither side can hold the other. The command asks this channel whether a control
 * would accept a toggle right now; a control subscribes only while it would, which is what makes
 * `available()` an honest answer instead of a guess.
 * @module @hrygo/dsh-speechrail-bundle/client/trigger
 */

/** Whether a toggle would be accepted now, and how to deliver one. */
export interface DictationTrigger {
  /** Whether a mounted control would accept a toggle at this moment. */
  available(): boolean
  /** Ask the mounted control to act on its own current phase. */
  toggle(): void
  /**
   * Subscribe one control.
   * @param handler - called on every toggle while subscribed.
   * @returns idempotent disposer removing that handler.
   */
  subscribe(handler: () => void): () => void
}

/**
 * Create the trigger channel owned by one plugin lifetime.
 * @returns a trigger with no subscribers.
 */
export function createDictationTrigger(): DictationTrigger {
  const handlers = new Set<() => void>()
  return {
    available: () => handlers.size > 0,
    toggle: () => {
      // Iterate a copy: a handler may unsubscribe while it runs (a capture that just finished
      // does), and one broken handler must not keep the others from being told.
      for (const handler of [...handlers]) {
        try {
          handler()
        } catch (error) {
          console.error('SpeechRail dictation trigger handler failed', error)
        }
      }
    },
    subscribe: (handler) => {
      handlers.add(handler)
      return () => { handlers.delete(handler) }
    },
  }
}
