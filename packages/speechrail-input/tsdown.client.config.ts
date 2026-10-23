import { defineConfig } from 'tsdown'

/**
 * Module-table rows resolved through the injected require, never inlined.
 *
 * React (and the shell's own cordis runtime) are the baseline a third-party client
 * artifact may rely on. Everything else is inlined, including the zod runtime the
 * generated Typert remote client uses: real third-party bundles carry their own
 * dependencies rather than assuming the module table exposes them, and no installed
 * plugin declares `dsh.client.external`.
 */
const CLIENT_EXTERNALS = [
  'react',
  'react-dom',
  'react-dom/client',
  'react/jsx-runtime',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-api-remotes/client',
  '@deepseek-ai/dsh-client-locale/client',
  '@deepseek-ai/dsh-client-ui-conversation/client',
  '@deepseek-ai/dsh-client-ui-slots',
]

/**
 * Inlined instead of required: the published protocol helpers are a pure wire layer
 * with no shared runtime identity, and zod is listed as a dependency of this package
 * (tsdown externalizes dependencies by default), yet the browser face must carry it.
 */
const CLIENT_INLINED = [/^@deepseek-ai\/dsh-typert-protocol(\/|$)/, /^zod(\/|$)/]

/** Browser face: one module-loader registration served as /plugins/<package>/client.js. */
export default defineConfig({
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  deps: { neverBundle: CLIENT_EXTERNALS, alwaysBundle: CLIENT_INLINED },
  outputOptions: {
    entryFileNames: 'client.js',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    banner: (chunk) =>
      `window.__ModuleLoader__.load({ id: "@hrygo/dsh-speechrail-bundle", ${chunk.isEntry ? '' : `chunk: ${JSON.stringify(chunk.fileName)}, `}factory: (require) => {`,
    footer: 'return module.exports; } });',
  },
})
