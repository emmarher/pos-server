/**
 * .eslintrc.cjs — Configuración de ESLint del backend.
 *
 * ────────────────────────────────────────────────────────────────────────
 * Qué hace este archivo:
 *   - Lint de TypeScript con typescript-eslint (parser + recommended).
 *   - Ignora dist/ y node_modules (el build de tsc no se lint-ea).
 * ────────────────────────────────────────────────────────────────────────
 */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    tsconfigRootDir: __dirname,
    project: ['./tsconfig.json', './tsconfig.test.json'],
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:@typescript-eslint/recommended-requiring-type-checking',
  ],
  env: {
    node: true,
    es2022: true,
  },
  ignorePatterns: ['dist/', 'node_modules/'],
  overrides: [
    {
      /* Tests: relajar reglas de tipado estricto (respuestas any de
         inject, mocks asíncronos triviales, referencia types vitest). */
      files: ['tests/**/*.ts', 'vitest.config.ts'],
      rules: {
        '@typescript-eslint/no-unsafe-assignment': 'off',
        '@typescript-eslint/no-unsafe-member-access': 'off',
        '@typescript-eslint/no-unsafe-call': 'off',
        '@typescript-eslint/no-unsafe-return': 'off',
        '@typescript-eslint/require-await': 'off',
        '@typescript-eslint/triple-slash-reference': 'off',
      },
    },
  ],
};
