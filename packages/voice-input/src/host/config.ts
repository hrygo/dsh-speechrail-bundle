/**
 * Declarative configuration of this bundle's Loader entry.
 * @module dsh-voice-input/host/config
 */

import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  DEFAULT_BASE_URL,
  DEFAULT_CREDENTIAL_REF,
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_CREDENTIAL_REF_LENGTH,
  MAX_MODEL_LENGTH,
  MAX_REQUEST_TIMEOUT_MS,
  MIN_REQUEST_TIMEOUT_MS,
  type SpeechRailLanguageMode,
} from '../contracts.ts'

/**
 * Entry schema rendered by the settings page.
 *
 * `language`, `model` and `requestTimeoutMs` are volatile so a settings write applies to
 * the next operation without reloading the plugin. A volatile field parses to a
 * `{ get() }` handle rather than a plain value, so it must never be read directly:
 * {@link readConfig} is the only sanctioned reader.
 *
 * The endpoint stays static because changing it re-points where a credential resolved on this
 * machine is sent, and that decision belongs to the entry, not to a page a plugin renders. The
 * model id names weights on an endpoint that was already chosen, so it is editable where it is
 * often the one thing standing between a user and a working second engine (ADR-0004).
 *
 * The credential reference is editable too, and it is the one field here whose edit changes which
 * stored secret is spent rather than where it goes: `baseUrl` cannot move, the value accepted is a
 * name and never a secret, and a name outside the credentials grammar is refused rather than stored
 * (ADR-0007). Before that, a wrong or missing reference was a dead end on this page: the row reported
 * "not configured" and the only way to fix it was to edit the entry by hand.
 */
export const Config = z.object({
  baseUrl: z.string().default(DEFAULT_BASE_URL),
  // Bounded for the same reason the write path bounds it: the value is user input that reaches a
  // multipart field, and an engine that accepted a 200-character model id would be the first one.
  model: z.string().max(MAX_MODEL_LENGTH).default('').volatile(),
  // No `min(1)`: an explicitly empty reference is a supported state meaning "this endpoint needs no
  // credential" - the request then carries no Authorization header at all. A non-empty reference
  // that resolves to nothing is still refused as `not-configured`. See ADR-0003.
  credentialRef: z.string().max(MAX_CREDENTIAL_REF_LENGTH).default(DEFAULT_CREDENTIAL_REF).volatile(),
  language: z.union(['auto', 'zh', 'en']).default('auto').volatile(),
  requestTimeoutMs: z.natural().min(MIN_REQUEST_TIMEOUT_MS).max(MAX_REQUEST_TIMEOUT_MS).default(DEFAULT_REQUEST_TIMEOUT_MS).volatile(),
})

/** Runtime values the Loader validated from {@link Config}. */
export interface SpeechRailInputConfig {
  /** Loopback SpeechRail base URL ending in `/v1`. */
  baseUrl: string
  /** Optional explicit model id; empty lets the service choose. */
  model: Volatile<string>
  /** Credential reference resolved for every operation; empty means the endpoint needs none. */
  credentialRef: Volatile<string>
  /** Volatile language hint handle; read it through {@link readConfig}. */
  language: Volatile<SpeechRailLanguageMode>
  /** Volatile request budget handle; read it through {@link readConfig}. */
  requestTimeoutMs: Volatile<number>
}

/** Plain values unwrapped from {@link SpeechRailInputConfig}. */
export interface SpeechRailInputConfigValues {
  /** Loopback SpeechRail base URL ending in `/v1`. */
  baseUrl: string
  /** Optional explicit model id; empty lets the service choose. */
  model: string
  /** Credential reference resolved for every operation; empty means the endpoint needs none. */
  credentialRef: string
  /** Language hint, or `auto` to omit it. */
  language: SpeechRailLanguageMode
  /** One request budget in milliseconds. */
  requestTimeoutMs: number
}

/**
 * Unwrap a Loader-parsed configuration into plain values.
 *
 * Volatile fields arrive as `{ get() }` handles; reading them as plain strings or
 * numbers throws at runtime while still typechecking, which is exactly the failure
 * this function exists to prevent. `tests/config.host.spec.ts` drives the real
 * schema through it.
 * @param config - configuration as the Loader parsed it.
 * @returns the plain values for one operation.
 */
export function readConfig(config: SpeechRailInputConfig): SpeechRailInputConfigValues {
  const language = config.language.get()
  return {
    baseUrl: config.baseUrl,
    model: config.model.get(),
    credentialRef: config.credentialRef.get(),
    language: language === 'zh' || language === 'en' ? language : 'auto',
    requestTimeoutMs: config.requestTimeoutMs.get(),
  }
}
