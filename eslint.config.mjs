// Deliberately minimal: only the two high-signal, type-aware promise rules that
// matter most for this fire-and-forget daemon. The process-safety handler makes
// unhandledRejection NON-fatal (it logs and swallows), so a stray un-awaited /
// un-voided promise silently never completes (a missed liquidation or
// un-persisted nonce floor) with no crash and no test failure. These rules are
// the static backstop for exactly that class of bug. The full
// recommendedTypeChecked set is intentionally NOT enabled to keep the surface
// small and the signal high.
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    files: ['src/**/*.ts', 'scripts/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
  {
    ignores: [
      'artifacts/**',
      'cache/**',
      'typechain-types/**',
      'node_modules/**',
    ],
  }
);
