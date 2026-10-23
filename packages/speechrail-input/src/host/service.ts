/**
 * Host service binding the transcription engine to DSH credentials, storage and settings.
 * @module @hrygo/dsh-speechrail-bundle/host/service
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { credentialRef as credentialReference, isCredentialRefName } from '@deepseek-ai/dsh-credentials'
import { SettingsConflictError } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-storage'
import {
  type SpeechRailAcknowledgeResult,
  type SpeechRailCheckResult,
  type SpeechRailConfigureResult,
  type SpeechRailInputStatus,
  type SpeechRailLanguageMode,
  type SpeechRailTranscriptionResult,
} from '../contracts.ts'
import { Config, readConfig, type SpeechRailInputConfig } from './config.ts'
import { SpeechRailInputCore, type ResolvedConfig } from './core.ts'
import { normalizeEndpoint } from './endpoint.ts'
import { probeCapabilities, transcribe as httpTranscribe } from './http.ts'
import {
  JOURNAL_UNIT,
  JOURNAL_VERSION,
  journalFromUnit,
  type JournalState,
  type PendingJournal,
} from './journal.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Independent SpeechRail voice input service. */
    speechrailInput: SpeechRailInput
  }
}

/** Storage members this service uses, kept structural so no backend type leaks in. */
interface OpenedUnit {
  loadAll(): Promise<{ readonly global: unknown }>
  setGlobal(value: unknown): Promise<void>
  close(): Promise<void>
}

/** Transcription service: one in-flight operation, one durable pending record. */
export default class SpeechRailInput extends Service {
  /** Entry configuration schema rendered by the settings page. */
  static Config = Config

  private readonly core: SpeechRailInputCore
  private readonly entryId: string | undefined
  private readonly opened: { unit: OpenedUnit | null } = { unit: null }

  constructor(ctx: Context, private readonly config: SpeechRailInputConfig) {
    super(ctx, 'speechrailInput')
    this.entryId = ctx.fiber.entry?.options.id
    this.core = new SpeechRailInputCore({
      now: () => new Date(),
      config: () => this.resolveConfig(),
      resolveCredential: async (ref) => await this.resolveCredential(ref),
      journal: this.createJournal(),
      transcribe: async (options) => await httpTranscribe(options),
      probe: async (options) => await probeCapabilities(options),
      settingsRevision: () => this.settingsRevision(),
      writeSettings: async (patch, expectedRevision) => await this.writeSettings(patch, expectedRevision),
    })
    ctx.effect(() => () => { this.dispose() })
  }

  /**
   * Read the durable journal so an unproven earlier upload survives a reload.
   * @returns after the gate reflects what the medium already holds.
   */
  async restore(): Promise<void> {
    await this.core.restore()
  }

  /** Release the storage unit this service opened. */
  dispose(): void {
    const unit = this.opened.unit
    this.opened.unit = null
    if (unit !== null) void unit.close().catch(() => undefined)
  }

  /** @returns everything the settings page and composer control render. */
  async status(): Promise<SpeechRailInputStatus> {
    return await this.core.status()
  }

  /** @returns what one connectivity and capability probe observed. */
  async check(): Promise<SpeechRailCheckResult> {
    return await this.core.check()
  }

  /**
   * Persist language and request budget after a revision check.
   * @param payload - JSON carrier text.
   * @returns the new revision or a localized-code failure.
   */
  async configure(payload: string): Promise<SpeechRailConfigureResult> {
    return await this.core.configure(payload)
  }

  /**
   * Upload one recording without ever replaying or queuing it.
   * @param payload - JSON carrier text holding the operation id and base64 audio.
   * @param signal - caller cancellation.
   * @returns the transcript, or a sanitized failure.
   */
  async transcribe(payload: string, signal?: AbortSignal | undefined): Promise<SpeechRailTranscriptionResult> {
    return await this.core.transcribe(payload, signal)
  }

  /**
   * Clear an unproven outcome the user explicitly acknowledged.
   * @param payload - JSON carrier text holding the operation id.
   * @returns the remaining pending operation, or a refusal.
   */
  async acknowledgeUnknown(payload: string): Promise<SpeechRailAcknowledgeResult> {
    return await this.core.acknowledgeUnknown(payload)
  }

  /** Read the effective configuration, normalizing the endpoint on every call. */
  private resolveConfig(): ResolvedConfig {
    const values = readConfig(this.config)
    const endpoint = normalizeEndpoint(values.baseUrl)
    return {
      baseUrl: endpoint.ok ? endpoint.baseUrl : '',
      endpointRefusal: endpoint.ok ? null : endpoint.reason,
      model: values.model.trim(),
      credentialRef: values.credentialRef,
      language: values.language,
      requestTimeoutMs: values.requestTimeoutMs,
    }
  }

  /** Resolve the credential reference, treating a refusal as absent. */
  private async resolveCredential(ref: string): Promise<string | null> {
    if (!isCredentialRefName(ref)) return null
    try {
      const resolved = await this.ctx.credentials.resolve(credentialReference(ref))
      if (resolved === undefined) return null
      return resolved.value === '' ? null : resolved.value
    } catch {
      return null
    }
  }

  /** Current revision of this entry's settings namespace. */
  private settingsRevision(): number | null {
    const settings = this.ctx.get('settings')
    const entryId = this.entryId
    if (settings === undefined || entryId === undefined) return null
    try {
      return settings.describe().find((descriptor) => descriptor.ns === entryId)?.revision ?? null
    } catch {
      return null
    }
  }

  /** Persist the editable subset of this entry. */
  private async writeSettings(
    patch: { readonly language: SpeechRailLanguageMode; readonly requestTimeoutMs: number },
    expectedRevision: number,
  ): Promise<'ok' | 'conflict' | 'failed'> {
    const settings = this.ctx.get('settings')
    const entryId = this.entryId
    if (settings === undefined || entryId === undefined) return 'failed'
    try {
      await settings.update(entryId, patch, expectedRevision)
      return 'ok'
    } catch (error) {
      return error instanceof SettingsConflictError ? 'conflict' : 'failed'
    }
  }

  /**
   * Build the durable journal over the JSON storage backend.
   *
   * Without a usable medium every question fails closed, so this package never
   * uploads audio it could not account for after a reload.
   */
  private createJournal(): PendingJournal {
    let pending: Promise<OpenedUnit | null> | null = null
    const open = async (): Promise<OpenedUnit | null> => {
      const storage = this.ctx.get('storage')
      if (storage === undefined) return null
      if (this.opened.unit !== null) return this.opened.unit
      try {
        const kv = storage.backend.get('json').kv
        if (kv === undefined) return null
        const unit = await kv.open({
          name: JOURNAL_UNIT,
          version: JOURNAL_VERSION,
          tables: [],
          hasGlobal: true,
          layout: 'single',
        }) as unknown as OpenedUnit
        this.opened.unit = unit
        return unit
      } catch {
        return null
      }
    }
    const unit = async (): Promise<OpenedUnit | null> => {
      if (pending === null) {
        pending = open()
        const resolved = await pending
        if (resolved === null) pending = null
        return resolved
      }
      return await pending
    }
    const facade = (target: OpenedUnit): PendingJournal => journalFromUnit({
      readGlobal: async () => (await target.loadAll()).global,
      writeGlobal: async (value) => { await target.setGlobal(value) },
    })
    return {
      read: async (): Promise<JournalState> => {
        const target = await unit()
        return target === null ? { available: false } : await facade(target).read()
      },
      reset: async (): Promise<boolean> => {
        const target = await unit()
        return target === null ? false : await facade(target).reset()
      },
      record: async (entry) => {
        const target = await unit()
        return target === null ? false : await facade(target).record(entry)
      },
      clear: async (operationId) => {
        const target = await unit()
        return target === null ? false : await facade(target).clear(operationId)
      },
    }
  }
}
