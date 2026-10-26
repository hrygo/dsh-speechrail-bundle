/**
 * Workspace-only type shim for the published `@deepseek-ai/dsh-typert-protocol`.
 *
 * Why it exists: the Typert generator discovers Remote surfaces only when the
 * `@Remote` decorator and the `TypertRemoteService` base class resolve to symbols
 * declared inside a package registered under `<workspace>/packages` whose manifest
 * name is exactly `@deepseek-ai/dsh-typert-protocol` (`isTypeMetaSymbol` and
 * `loadRegistrations` in @deepseek-ai/dsh-typert-generator). An out-of-monorepo
 * bundle that only depends on the published npm package satisfies neither
 * condition, so generation fails with "publishes Remote artifacts but has no
 * Remote methods".
 *
 * This file restores that topology without touching runtime behaviour:
 * - `tsconfig.base.json` maps the bare specifier here, so the generator sees a
 *   registered declaration site for both symbols in both faces.
 * - Being a declaration file, it is never emitted, never linked by pnpm and never
 *   loaded; the bundle keeps importing the published package at runtime.
 * - `packages/voice-input/tests/typert-protocol-parity.host.spec.ts` proves
 *   the published package still exports these symbols and that the decorator and
 *   constructor pattern this bundle uses compiles against the published
 *   declarations too.
 *
 * Only the surface this bundle consumes is declared. Never add behaviour.
 * @module @deepseek-ai/dsh-typert-protocol
 */

import { Service, type Context } from '@deepseek-ai/cordis'

/** One sanitized Remote failure as the wire carries it. */
export interface RemoteFailure {
  /** Stable machine-readable code. */
  readonly code: string
  /** Transport-level message. */
  readonly message: string
  /** Optional structured details. */
  readonly details?: unknown
}

/** One Remote call outcome. */
export type RemoteResult<T> =
  | { readonly ok: true, readonly value: T }
  | { readonly ok: false, readonly error: RemoteFailure }

/** Generated Host-for-Client Remote contribution. */
export interface TypertRemoteContribution {
  /** npm package that owns the Remote methods. */
  readonly package: string
  /** Consumer-side invocation descriptors generated from that package. */
  readonly descriptors: readonly unknown[]
}

/** Optional wire namespace of a gateway binding. */
export interface TypertGatewayBindingOptions {
  /** Namespace override; defaults to the service key. */
  readonly namespace?: string
}

/** Decorator returned by the named and options forms of {@link Remote}. */
export type RemoteMethodDecorator = <This extends object, Args extends unknown[], Result>(
  method: (this: This, ...args: Args) => Result,
  context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
) => void

/** Mark one public instance method as a direct Remote invocation. */
export function Remote<This extends object, Args extends unknown[], Result>(
  method: (this: This, ...args: Args) => Result,
  context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
): void
/** Mark one public instance method with an endpoint name. */
export function Remote(name: string): RemoteMethodDecorator
/**
 * Implementation signature kept only so the module has a value; nothing resolved
 * through this shim ever runs, because bundling and runtime resolve the published
 * package.
 * @param args - decorator arguments.
 * @returns never.
 */
export function Remote(...args: readonly unknown[]): unknown {
  void args
  throw new Error('typert protocol type shim: the published package is used at runtime')
}

/** Cordis Service base that exposes its registered name through the Typert Gateway. */
export abstract class TypertRemoteService<out T = never> extends Service<T> {
  /** Visible binding consumed by source-mode discovery. */
  readonly typertRemote!: unknown
  /**
   * Register the Service and bind the same key to the Typert Gateway.
   * @param ctx - owning Cordis Context.
   * @param serviceKey - Cordis service key and default wire namespace.
   * @param options - optional wire namespace.
   */
  protected constructor(ctx: Context, serviceKey: string, options?: TypertGatewayBindingOptions) {
    void options
    super(ctx, serviceKey)
  }
}
