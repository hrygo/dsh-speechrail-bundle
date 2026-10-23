/**
 * Declarative configuration of this bundle's Loader entry.
 * @module @hrygo/dsh-speechrail-bundle/host/config
 */

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
 * Editable fields are volatile so a settings write applies to the next operation
 * without reloading the plugin; the endpoint and credential reference stay static
 * because changing them re-points where a local secret is sent.
 */
export const Config = z.object({
  baseUrl: z.string().default(DEFAULT_BASE_URL).volatile(),
  model: z.string().default('').volatile(),
  credentialRef: z.string().min(1).default(DEFAULT_CREDENTIAL_REF).volatile(),
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
  /** Language hint, or `auto` to omit it. */
  language: SpeechRailLanguageMode
  /** One request budget in milliseconds. */
  requestTimeoutMs: number
}
