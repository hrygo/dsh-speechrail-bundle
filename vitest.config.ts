import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'host',
          environment: 'node',
          include: ['packages/speechrail-input/tests/**/*.host.spec.ts'],
        },
      },
      {
        test: {
          name: 'client',
          environment: 'jsdom',
          include: ['packages/speechrail-input/tests/**/*.client.spec.ts', 'packages/speechrail-input/tests/**/*.client.spec.tsx'],
        },
      },
    ],
  },
})
