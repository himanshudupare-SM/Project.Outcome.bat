import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Surfaces genuinely risky patterns; noise-only rules stay off.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { attributes: false } },
      ],
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'off',
    },
  },
  {
    // Config, script and end-to-end files run outside the typed project graph.
    files: ['**/*.config.ts', '**/*.config.js', 'eslint.config.js', 'e2e/**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ['e2e/**/*.mjs'],
    languageOptions: {
      parserOptions: { projectService: false, project: false },
      // `process`/`console`/`fetch` are Node's; `DataTransfer` runs inside page.evaluate.
      globals: { process: 'readonly', console: 'readonly', fetch: 'readonly', URL: 'readonly', DataTransfer: 'readonly' },
    },
  },
);
