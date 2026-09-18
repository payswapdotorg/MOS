// ESLint 9 flat config.
// Static ARCHITECTURE enforcement (module boundaries, dependency matrix, adapter
// isolation) is handled by the dedicated checker in tools/arch-check — see
// `npm run arch:check` and tests/architecture. ESLint covers code quality only.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'tests/architecture/fixtures/**', // deliberately violating sample code, parsed only by the arch checker
      'var/**',
      '.test-deps/**',
      // The console/ sub-package is a self-contained Next.js app with its OWN
      // lint gate (`cd console && bun run lint`) and its own eslint config;
      // its shadcn-style sources legitimately use patterns the backend rules
      // forbid (e.g. type-only default imports). Gate it there, not here.
      'console/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      'no-console': 'off',
    },
  },
);
