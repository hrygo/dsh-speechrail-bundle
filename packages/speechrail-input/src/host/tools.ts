/**
 * Thin agent entry point.
 *
 * One read-only tool that reports whether local voice input is usable, so an agent
 * can explain a failure ("the service is not running", "the credential is missing",
 * "an earlier recording still needs acknowledgement") without the user opening the
 * settings page. It records nothing, uploads nothing and never exposes the
 * credential: only the reference and a boolean cross the boundary.
 *
 * The definition is written structurally instead of through `@deepseek-ai/dsh-tools`
 * because importing that package's declarations pulls `@deepseek-ai/dsh-llm` into the
 * Typert-analyzed program, where an unrelated lookup declaration fails analysis. The
 * shapes below are exactly what that package compiles to; `tools/check-tool-schema.mjs`
 * asserts both the compiled-JSON parity and the registry's own schema check, because
 * the compiler cannot.
 *
 * Registering this way validates `output.schema` and every result against it, but it
 * does not validate arguments: `execute` therefore treats only an explicit
 * `probe: true` as a probe and tolerates every other value.
 * @module @hrygo/dsh-speechrail-bundle/host/tools
 */

import type {
  SpeechRailAuthentication,
  SpeechRailCheckResult,
  SpeechRailInputStatus,
  SpeechRailTranscriptionSupport,
} from '../types.ts'

/** Registered tool name. */
export const STATUS_TOOL_NAME = 'speechrail_input_status'

/** One model-facing text block. */
export interface ToolTextBlock {
  /** Content block discriminator. */
  readonly type: 'text'
  /** Bounded text handed to the model. */
  readonly text: string
}

/** Implicit open object root the registry sends to the model. */
export interface ToolParameterSchema {
  /** Node type of the parameter root. */
  readonly type: 'object'
  /** Per-property schemas. */
  readonly properties: Readonly<Record<string, unknown>>
  /** Names that must be present; omitted when every property is optional. */
  readonly required?: readonly string[]
  /** Whether undeclared properties are rejected. */
  readonly additionalProperties?: boolean
}

/** Tool definition shape accepted by the Harness tools registry. */
export interface HarnessToolDefinition {
  /** Unique tool name. */
  readonly name: string
  /** Model-facing description. */
  readonly description: string
  /** Parameter schema. */
  readonly parameters: ToolParameterSchema
  /** Canonical output schema plus its projection. */
  readonly output: {
    /** Raw JSON Schema enforced against every successful value. */
    readonly schema: Readonly<Record<string, unknown>>
    /** Projection from validated arguments and value to model content. */
    render(args: unknown, value: unknown): readonly ToolTextBlock[]
  }
  /**
   * Run one accepted call.
   * @param args - validated model arguments.
   * @returns the canonical value declared by `output.schema`.
   */
  execute(args: { readonly probe?: boolean }): Promise<StatusToolValue>
}

/** The only part of the Harness tools service this bundle uses. */
export interface ToolRegistry {
  /**
   * Add one tool for the life of the caller's scope.
   * @param definition - registry-ready definition.
   * @returns the disposer that withdraws the tool.
   */
  register(definition: HarnessToolDefinition): () => void
}

/** Host surface the tool reads; narrowed so a test can stub it. */
export interface StatusToolSource {
  /** Read the current state without touching the network. */
  status(): Promise<SpeechRailInputStatus>
  /** Probe the local service once and report reachability and limits. */
  check(): Promise<SpeechRailCheckResult>
}

/** Canonical value this tool returns. */
export interface StatusToolValue {
  /** Whether the configured credential reference resolves to a non-empty value. */
  readonly credentialConfigured: boolean
  /** Effective loopback base URL, or an empty string when it was refused. */
  readonly endpoint: string
  /** Why the configured endpoint is unusable, or an empty string. */
  readonly endpointProblem: string
  /** Configured model id, or an empty string when the service chooses. */
  readonly model: string
  /** Configured language mode. */
  readonly language: string
  /** Language hint the next upload will actually carry, or an empty string when none will. */
  readonly languageHint: string
  /**
   * What is known about the transcription operation: `unsupported` means every upload is refused.
   *
   * Deliberately not named like `SpeechRailCapabilitiesView.transcriptionSupported`, which is the
   * service's own boolean claim: the two travel on the same boundary and same-named fields of
   * different types invite exactly the confusion this type exists to remove.
   */
  readonly transcriptionSupport: SpeechRailTranscriptionSupport
  /** Language modes the snapshot in force admits for this endpoint. */
  readonly languageOptions: readonly string[]
  /** Whether a recording may start, or the state blocking it. */
  readonly gate: string
  /** Operation id awaiting acknowledgement, or an empty string. */
  readonly pendingOperationId: string
  /** Largest upload the next recording may produce. */
  readonly maxUploadBytes: number
  /** Longest recording the next upload may contain. */
  readonly maxAudioSeconds: number
  /** Whether the local service was asked during this call. */
  readonly probed: boolean
  /** Whether the local service answered; false when it was not asked. */
  readonly reachable: boolean
  /** What the probe proved about the credential; `unverified` when it judged nothing. */
  readonly authenticated: SpeechRailAuthentication
  /** Failure code of the probe in this call, or an empty string. */
  readonly failureCode: string
  /** Failure code of the most recent upload, or an empty string when the last one succeeded. */
  readonly lastFailureCode: string
  /** HTTP status that upload received, or 0 when nothing answered. */
  readonly lastFailureHttpStatus: number
}

/** Canonical output schema, matching `defineTool`'s compiled form. */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    credentialConfigured: { type: 'boolean', description: 'Whether the configured credential reference resolves to a non-empty value.' },
    endpoint: { type: 'string', description: 'Effective loopback base URL, or an empty string when the configured endpoint was refused.' },
    endpointProblem: { type: 'string', description: 'Why the configured endpoint is unusable, or an empty string when it is fine.' },
    model: { type: 'string', description: 'Configured model id, or an empty string when the service chooses.' },
    language: { type: 'string', description: 'Configured language mode: `auto`, `zh` or `en`.' },
    languageHint: { type: 'string', description: 'The language hint the next upload will actually carry, or an empty string when none will.' },
    languageOptions: {
      type: 'array',
      items: { type: 'string' },
      description: 'Language modes the snapshot in force admits for this endpoint.',
    },
    transcriptionSupport: {
      type: 'string',
      enum: ['supported', 'unsupported', 'unknown'],
      description: 'Whether the endpoint states it can transcribe: `unsupported` means every upload is refused before the audio is sent, `unknown` that no snapshot said.',
    },
    gate: { type: 'string', description: 'Whether a recording may start: `ready` otherwise, or the blocking state.' },
    pendingOperationId: { type: 'string', description: 'Operation id awaiting acknowledgement, or an empty string when none is.' },
    maxUploadBytes: { type: 'number', description: 'Largest upload the next recording may produce.' },
    maxAudioSeconds: { type: 'number', description: 'Longest recording the next upload may contain.' },
    probed: { type: 'boolean', description: 'Whether the local service was asked during this call.' },
    reachable: { type: 'boolean', description: 'Whether the local service answered; false when it was not asked.' },
    authenticated: {
      type: 'string',
      enum: ['accepted', 'refused', 'unverified'],
      description: 'What the probe proved about the credential: `accepted` only after a 200, `refused` after a 401/403, `unverified` when nothing judged it.',
    },
    failureCode: { type: 'string', description: 'Probe failure code in this call, or an empty string.' },
    lastFailureCode: {
      type: 'string',
      description: 'Failure code of the most recent upload, or an empty string when the last one succeeded. This is why the gate is closed, when it is.',
    },
    lastFailureHttpStatus: { type: 'number', description: 'HTTP status that upload received, or 0 when nothing answered.' },
  },
  required: [
    'credentialConfigured', 'endpoint', 'endpointProblem', 'model', 'language', 'languageHint',
    'languageOptions', 'transcriptionSupport', 'gate', 'pendingOperationId', 'maxUploadBytes',
    'maxAudioSeconds', 'probed', 'reachable', 'authenticated', 'failureCode',
    'lastFailureCode', 'lastFailureHttpStatus',
  ],
} as const

/**
 * Build the status tool over one Host service.
 * @param source - Host service to read.
 * @returns a registry-ready definition.
 */
export function createStatusTool(source: StatusToolSource): HarnessToolDefinition {
  return {
    name: STATUS_TOOL_NAME,
    description:
      'Report whether local SpeechRail voice input is usable right now: the effective loopback endpoint, whether it is accepted, whether the configured credential resolves, whether the service answers and accepts that credential, whether the endpoint states it can transcribe at all, the language hint that will actually be sent and the upload limits in force, and whether an earlier recording is still awaiting acknowledgement.',
    parameters: {
      type: 'object',
      properties: {
        probe: {
          type: 'boolean',
          description:
            'Also ask the local service for its current capabilities, which reports reachability, authentication and the service-advertised limits. Costs one local request. Omit to report the last known state without any network access.',
        },
      },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: describeStatus(value as StatusToolValue) }],
    },
    async execute(args) {
      // Raw registration does not re-validate arguments, so treat anything other
      // than an explicit `true` as "do not probe".
      const asked = (args as { readonly probe?: unknown } | null | undefined)?.probe === true
      const check = asked ? await source.check() : null
      // A check that never left the host (no credential, unusable endpoint) did not ask
      // the service anything, so reporting it as an unreachable service would be false.
      const probed = check !== null
        && check.failure?.code !== 'not-configured'
        && check.failure?.code !== 'endpoint-invalid'
      const view = await source.status()
      return {
        credentialConfigured: view.credentialConfigured,
        endpoint: view.baseUrl,
        endpointProblem: view.endpointProblem ?? '',
        model: view.model,
        language: view.language,
        languageHint: view.languageHint,
        transcriptionSupport: view.transcriptionSupport,
        languageOptions: [...view.languageOptions],
        gate: view.gate,
        pendingOperationId: view.pendingOperationId ?? '',
        maxUploadBytes: view.limits.maxUploadBytes,
        maxAudioSeconds: view.limits.maxAudioSeconds,
        probed,
        reachable: check?.reachable ?? false,
        authenticated: check?.authenticated ?? 'unverified',
        failureCode: check?.failure?.code ?? '',
        lastFailureCode: view.lastFailure?.code ?? '',
        lastFailureHttpStatus: view.lastFailure?.httpStatus ?? 0,
      }
    },
  }
}

/**
 * One-line human summary of a canonical value.
 * @param value - validated tool value.
 * @returns the model-facing text.
 */
export function describeStatus(value: StatusToolValue): string {
  const parts: string[] = []
  if (value.endpointProblem !== '') parts.push(`endpoint refused: ${value.endpointProblem}`)
  else parts.push(`endpoint ${value.endpoint === '' ? '(unset)' : value.endpoint}`)
  parts.push(value.credentialConfigured ? 'credential configured' : 'credential missing')
  if (value.probed) {
    // Three states, so a report never has to guess between "refused" and "never judged".
    parts.push(value.reachable
      ? value.authenticated === 'accepted'
        ? 'service reachable and authorized'
        : value.authenticated === 'refused'
          ? 'service reachable but rejecting the credential'
          : value.failureCode === 'capabilities-absent'
            // A transcription-only engine answers the upload perfectly well; the probe
            // only missed a capability snapshot, so this must not read as a refusal.
            ? 'service reachable; it reports no capabilities and is used as a plain transcription endpoint'
            : 'service reachable but not accepting the request'
      : 'service unreachable')
  }
  else parts.push('service not probed')
  // The language this snapshot puts on the wire, not the one that was configured: an agent must not
  // be told a hint travels while the snapshot withholds it. Phrased as the snapshot's fact rather
  // than a promise, because a check can replace the snapshot before the next upload.
  parts.push(value.languageHint === ''
    ? `language ${value.language} with no hint in force`
    : `language hint ${value.languageHint} in force`)
  if (value.transcriptionSupport === 'unsupported') {
    parts.push('transcription unsupported by the service: every upload is refused before the audio is sent')
  } else if (value.transcriptionSupport === 'unknown') {
    parts.push('transcription support not stated')
  }
  parts.push(`gate ${value.gate}`)
  if (value.pendingOperationId !== '') parts.push(`awaiting acknowledgement of ${value.pendingOperationId}`)
  // The cause, not only the action: a closed gate says an upload is unaccounted for, and without this
  // the reader has to guess what the service did.
  if (value.pendingOperationId !== '' && value.lastFailureCode !== '') {
    parts.push(value.lastFailureHttpStatus === 0
      ? `that attempt failed with ${value.lastFailureCode} before a response arrived`
      : `that attempt failed with ${value.lastFailureCode} (HTTP ${String(value.lastFailureHttpStatus)})`)
  }
  parts.push(`limits ${String(value.maxUploadBytes)} bytes / ${String(value.maxAudioSeconds)}s`)
  return parts.join('; ')
}
