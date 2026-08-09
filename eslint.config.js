// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  },
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    rules: {
      /**
       * stdout is the JSON-RPC transport. Anything written to it that is not a
       * protocol frame corrupts the stream and the client disconnects with an
       * unhelpful parse error that never points at the line responsible.
       *
       * console.error and console.warn go to stderr in Node and are safe.
       * Everything else lands on stdout and is banned. Use the logger in
       * src/logging.ts rather than reaching for console at all.
       */
      'no-console': [
        'error',
        { allow: ['error', 'warn'] },
      ],

      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    // The logger owns the console, and its test has to call the banned methods
    // to prove the guard intercepts them. These are the only two exceptions.
    files: ['src/logging.ts', 'test/logging.test.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    // CLI stdout is a product surface, not the MCP transport: the console ban
    // protects a JSON-RPC stream the CLI does not carry. Only src/cli/.
    files: ['src/cli/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
);
