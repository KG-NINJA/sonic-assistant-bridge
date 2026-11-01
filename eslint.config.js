import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/**', '.npm-cache/**', 'artifacts/**', 'dist/**', 'pages/**', 'vendor/**'] },
  js.configs.recommended,
  { languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: { ...globals.browser, ...globals.node } }, rules: { 'no-unused-vars': ['error', { caughtErrors: 'none' }] } },
];
