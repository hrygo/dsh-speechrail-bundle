/**
 * Workspace-only type shim for the published `@deepseek-ai/dsh-typert-protocol`.
 *
 * Why it exists: the Typert generator discovers Remote surfaces only when the
 * `@Remote` decorator and `TypertRemoteService` base class resolve to a package
 * registered under `<workspace>/packages` whose manifest name is exactly
 * `@deepseek-ai/dsh-typert-protocol` (see `isTypeMetaSymbol` and
 * `loadRegistrations` in the generator). An out-of-monorepo bundle that depends
 * on the published npm package satisfies neither condition, so generation fails
 * with "publishes Remote artifacts but has no Remote methods".
 *
 * This package restores that topology without changing runtime behaviour:
 * - `tsconfig.base.json` maps the bare specifier here, so the generator sees a
 *   registered declaration site for both symbols.
 * - Nothing depends on this package, so pnpm never links it and the bundle keeps
 *   importing the published package at runtime.
 * - `tests/typert-protocol-parity.host.spec.ts` proves that the published
 *   package still exports these symbols and that the exact decorator and
 *   constructor pattern used by this bundle compiles against the published
 *   declarations as well.
 *
 * Only the surface this bundle consumes is declared. Never add behaviour.
 * @module @deepseek-ai/dsh-typert-protocol
 */
/** @param args - decorator arguments; the shim is never executed. */
export function Remote(...args) {
    void args;
    throw new Error('typert protocol type shim: the published package is used at runtime');
}
/** Cordis Service base that exposes its registered name through the Typert Gateway. */
export class TypertRemoteService extends Service {
    /** Visible binding consumed by source-mode discovery. */
    typertRemote;
    /**
     * Register the Service and bind the same key to the Typert Gateway.
     * @param ctx - owning Cordis Context.
     * @param _serviceKey - Cordis service key and default wire namespace.
     * @param _options - optional wire namespace.
     */
    constructor(ctx, _serviceKey, _options) {
        super(ctx);
    }
}
//# sourceMappingURL=index.js.map