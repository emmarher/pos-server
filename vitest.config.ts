/// <reference types="vitest/config" />
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    /* Env de pruebas ANTES de cargar src/config/env.ts */
    setupFiles: ['./tests/setup-env.ts'],
    /* BD limpia + migraciones + seeds una sola vez por corrida */
    globalSetup: ['./tests/global-setup.ts'],
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
})
