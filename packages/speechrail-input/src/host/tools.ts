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
 * shapes below are exactly what the registry consumes (verified against
 * `defineTool`'s compiled output); the registry still validates arguments and results
 * against them at execution time.
 * @module @hrygo/dsh-speechrail-bundle/host/tools
 */

import type { SpeechRailCheckResult, SpeechRailInputStatus } from '../types.ts'

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
  /** Effective language hint. */
  readonly language: string
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
  /** Whether the service accepted the credential; false when it was not asked. */
  readonly authenticated: boolean
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
    language: { type: 'string', description: 'Effective language hint: `auto`, `zh` or `en`.' },
    gate: { type: 'string', description: 'Whether a recording may start: `ready` otherwise, or the blocking state.' },
    pendingOperationId: { type: 'string', description: 'Operation id awaiting acknowledgement, or an empty string when none is.' },
    maxUploadBytes: { type: 'number', description: 'Largest upload the next recording may produce.' },
    maxAudioSeconds: { type: 'number', description: 'Longest recording the next upload may contain.' },
    probed: { type: 'boolean', description: 'Whether the local service was asked during this call.' },
    reachable: { type: 'boolean', description: 'Whether the local service answered; false when it was not asked.' },
    authenticated: { type: 'boolean', description: 'Whether the service accepted the credential; false when it was not asked.' },
  },
  required: [
    'credentialConfigured', 'endpoint', 'endpointProblem', 'model', 'language', 'gate',
    'pendingOperationId', 'maxUploadBytes', 'maxAudioSeconds', 'probed', 'reachable', 'authenticated',
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
      'Report whether local SpeechRail voice input is usable right now: the effective loopback endpoint, whether it is accepted, whether the configured credential resolves, whether the service answers and accepts that credential, the language and upload limits in force, and whether an earlier recording is still awaiting acknowledgement.',
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
      const probed = (args as { readonly probe?: unknown } | null | undefined)?.probe === true
      const check = probed ? await source.check() : null
      const view = await source.status()
      return {
        credentialConfigured: view.credentialConfigured,
        endpoint: view.baseUrl,
        endpointProblem: view.endpointProblem ?? '',
        model: view.model,
        language: view.language,
        gate: view.gate,
        pendingOperationId: view.pendingOperationId ?? '',
        maxUploadBytes: view.limits.maxUploadBytes,
        maxAudioSeconds: view.limits.maxAudioSeconds,
        probed,
        reachable: check?.reachable ?? false,
        authenticated: check?.authenticated ?? false,
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
  if (value.probed) parts.push(value.reachable ? (value.authenticated ? 'service reachable and authorized' : 'service reachable but rejecting the credential') : 'service unreachable')
  else parts.push('service not probed')
  parts.push(`gate ${value.gate}`)
  if (value.pendingOperationId !== '') parts.push(`awaiting acknowledgement of ${value.pendingOperationId}`)
  parts.push(`limits ${String(value.maxUploadBytes)} bytes / ${String(value.maxAudioSeconds)}s`)
  return parts.join('; ')
}
