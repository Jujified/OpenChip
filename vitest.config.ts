import { mergeConfig } from 'vite'
import { defineConfig } from 'vitest/config'

import viteConfig from './vite.config.ts'

/**
 * The app's test suite: `npm test`.
 *
 * Vitest read `vite.config.ts` directly until this file existed, so it merges
 * that config rather than replacing it — otherwise the React and Tailwind
 * plugins would quietly drop out of the test environment.
 *
 * Only `src/` is collected.
 */
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      include: ['src/**/*.test.{ts,tsx}'],
    },
  }),
)
