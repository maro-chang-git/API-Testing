import js from '@eslint/js';
import globals from 'globals';

// Flat config (ESLint 9+). `npm run lint` targets scripts/ only.
export default [
  // Pre-bundled third-party libs — not ours to lint.
  { ignores: ['scripts/vendor/**'] },

  js.configs.recommended,

  // Browser ES modules: the app code.
  {
    files: ['scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    rules: {
      'no-unused-vars': ['warn', { args: 'none' }],
    },
  },

  // Node + Vitest globals for the test suite.
  {
    files: ['tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
];
