import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

// Config flat (ESLint 9) para el frontend Vite + React + TS.
// Reglas: recomendadas + hooks; las ruidosas quedan en `warn` para no romper
// el CI por deuda preexistente — los errores reales sí cortan.
export default tseslint.config(
  // Fixtures/scripts de tooling (usan @ts-nocheck a propósito) — fuera del lint de UI.
  { ignores: ['dist', 'node_modules', 'src/scripts/**', 'vite.config.ts', 'tailwind.config.js', 'postcss.config.js'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.es2022 },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
);
