/**
 * The keyboard command that starts and finishes one dictation.
 *
 * The command is a plain value, so its identity, its defaults and both of its resolutions are
 * testable without a Cordis Context; `mount.ts` only hands it to the shortcuts service.
 * @module dsh-voice-input/client/command
 */

import type { ShortcutCommand, ShortcutCommandId, ShortcutContext } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { DictationTrigger } from './trigger.ts'

/**
 * Copy this module needs, narrowed to the keys it reads and to no dependency on the locale
 * package. A namespace-bound translate accepts at least these keys, so `mount.ts` passes one
 * directly, while a test can pass `(key) => key`.
 */
export type Translate = (key: 'shortcut.dictate' | 'shortcut.unavailable') => string

/**
 * Apply a compile-time string brand without changing the value.
 *
 * Inlined rather than imported from `@deepseek-ai/dsh-brand`, so the client half keeps its three
 * runtime requires; the third-party `dsh-image-gen` bundle in this profile inlines it too.
 * @param value - command id admitted by the shortcuts registry.
 * @returns the same string, branded.
 */
function brandString<T extends string>(value: string | T): T {
  return value as T
}

/** Stable command identity; the shortcuts registry keys stored preferences by it. */
export const DICTATE_COMMAND_ID = brandString<ShortcutCommandId>('voice-input.dictate')

/**
 * Default chord, shared by every profile.
 *
 * `primary` is Command on macOS and Control elsewhere. It avoids every key the composer already
 * owns (Enter, Cmd/Ctrl+Enter, Shift+Enter, Escape, Tab) and the shell's stop sequence; the
 * registry still arbitrates, and `registerDictateCommand` survives a rejection.
 */
const DEFAULT_BINDING = { code: 'Space', modifiers: ['primary', 'shift'] } as const

/** Every runtime and platform the registry distinguishes gets the same default. */
const DEFAULT_BINDINGS = {
  'desktop:macos': DEFAULT_BINDING,
  'desktop:windows': DEFAULT_BINDING,
  'desktop:linux': DEFAULT_BINDING,
  'web:macos': DEFAULT_BINDING,
  'web:windows': DEFAULT_BINDING,
  'web:linux': DEFAULT_BINDING,
} as const

/** The slice of the shortcuts service this module needs, so it can be driven without a Context. */
export interface ShortcutRegistry {
  /** Contribute one editable command. */
  register: (command: ShortcutCommand) => () => void
}

/**
 * Describe the dictation command.
 * @param t - copy from this bundle's locale namespace.
 * @param trigger - the channel to the mounted composer control.
 * @returns the command the shortcuts service registers.
 */
export function createDictateCommand(t: Translate, trigger: DictationTrigger): ShortcutCommand {
  return {
    id: DICTATE_COMMAND_ID,
    label: () => t('shortcut.dictate'),
    aliases: [],
    defaults: DEFAULT_BINDINGS,
    // Both input regions: the caret may be in the composer or the page may hold focus. A terminal
    // is deliberately excluded - it owns its own keys.
    regions: ['page', 'editable'],
    // No modal may be open; a dialog has its own keyboard owner.
    modals: [],
    resolve: (_context: ShortcutContext) => (
      trigger.available()
        ? { status: 'handled' as const, run: () => { trigger.toggle() } }
        : { status: 'blocked' as const, reason: t('shortcut.unavailable') }
    ),
  }
}

/**
 * Register the command, keeping a rejected registration from taking the bundle down.
 *
 * The registry throws on a duplicate id or an overlapping default binding. Losing the shortcut is
 * a degraded bundle; failing to mount the composer would be a broken one, and the microphone is
 * the feature this bundle exists for.
 * @param shortcuts - the shortcuts service of this composition.
 * @param t - copy from this bundle's locale namespace.
 * @param trigger - the channel to the mounted composer control.
 * @returns idempotent disposer releasing the command.
 */
export function registerDictateCommand(shortcuts: ShortcutRegistry, t: Translate, trigger: DictationTrigger): () => void {
  try {
    return shortcuts.register(createDictateCommand(t, trigger))
  } catch (error) {
    console.error('SpeechRail dictation shortcut unavailable', error)
    return () => undefined
  }
}
