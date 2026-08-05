import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/build/**'],
    // Set here rather than as a `NODE_ENV=test` prefix on the npm scripts:
    // that prefix is shell syntax only POSIX shells understand, so `npm test`
    // failed on Windows before a single test ran. Setting it here works on
    // every OS and still forces `test` even if the shell exports something else.
    env: { NODE_ENV: 'test' },
  },
})
