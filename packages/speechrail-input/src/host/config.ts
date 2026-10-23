/**
 * Declarative configuration of this bundle's Loader entry.
 * @module @hrygo/dsh-speechrail-bundle/host/config
 */

import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  DEFAULT_BASE_URL,
  DEFAULT_CREDENTIAL_REF,
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_REQUEST_TIMEOUT_MS,
  MIN_REQUEST_TIMEOUT_MS,
  type SpeechRailLanguageMode,
} from '../contracts.ts'

/**
 * Entry schema rendered by the settings page.
 *
 * `language` and `requestTimeoutMs` are volatile so a settings write applies to
 * the next operation without reloading the plugin. A volatile field parses to a
 * `{ get() }` handle rather than a plain value, so it must never be read directly:
 * {@link readConfig} is the only sanctioned reader. The endpoint, model and
 * credential reference stay static because changing them re-points where a local
 * secret is sent and is applied by a reload.
 */
export const Config = z.object({
  baseUrl: z.string().default(DEFAULT_BASE_URL),
  model: z.string().default(''),
  credentialRef: z.string().min(1).default(DEFAULT_CREDENTIAL_REF),
  language: z.union(['auto', 'zh', 'en']).default('auto').volatile(),
  requestTimeoutMs: z.natural().min(MIN_REQUEST_TIMEOUT_MS).max(MAX_REQUEST_TIMEOUT_MS).default(DEFAULT_REQUEST_TIMEOUT_MS).volatile(),
})

/** Runtime values the Loader validated from {@link Config}. */
export interface SpeechRailInputConfig {
  /** Loopback SpeechRail base URL ending in `/v1`. */
  baseUrl: string
  /** Optional explicit model id; empty lets the service choose. */
  model: string
  /** Credential reference resolved for every operation. */
  credentialRef: string
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
  /** Credential reference resolved for every operation. */
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
    model: config.model,
    credentialRef: config.credentialRef,
    language: language === 'zh' || language === 'en' ? language : 'auto',
    requestTimeoutMs: config.requestTimeoutMs.get(),
  }
}
