import { defineConfig } from 'tsdown'

/**
 * Module-table rows resolved through the injected require, never inlined. The
 * official client bundles require the same set (react, cordis, zod and the
 * injected UI packages), so these rows exist in the shell's module table.
 */
const CLIENT_EXTERNALS = [
  'react',
  'react-dom',
  'react-dom/client',
  'react/jsx-runtime',
  'zod',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-api-remotes/client',
  '@deepseek-ai/dsh-client-locale/client',
  '@deepseek-ai/dsh-client-ui-conversation/client',
  '@deepseek-ai/dsh-client-ui-slots',
]

/**
 * The published protocol helpers are a pure wire layer with no shared runtime
 * identity, so they are inlined (subpaths included) rather than required.
 */
const CLIENT_INLINED = [/^@deepseek-ai\/dsh-typert-protocol(\/|$)/]

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
