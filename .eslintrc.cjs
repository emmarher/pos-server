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
    project: ['./tsconfig.json'],
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
};
