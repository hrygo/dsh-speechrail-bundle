import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'host',
          environment: 'node',
          include: ['packages/voice-input/tests/**/*.host.spec.ts'],
        },
      },
      {
        test: {
          name: 'client',
          environment: 'jsdom',
          include: ['packages/voice-input/tests/**/*.client.spec.ts', 'packages/voice-input/tests/**/*.client.spec.tsx'],
        },
      },
    ],
  },
})
