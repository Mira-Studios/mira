import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default [
  {
    ignores: [
      "dist/**", 
      "apps/desktop/dist/**",
      "node_modules/**", 
      "release/**",
      "apps/desktop/release/**"
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['electron/**/*.{js,ts}', 'apps/desktop/electron/**/*.{js,ts}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      'no-redeclare': 'off',
    },
  },
  {
    files: ['src/**/*.{ts,tsx,js,jsx}', 'apps/desktop/src/**/*.{ts,tsx,js,jsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parser: tseslint.parser,
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
      globals: {
        ...globals.browser,
        React: 'readonly',
      },
    },
    plugins: {
      react,
      'react-hooks': reactHooks,
    },
    rules: {
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
    settings: {
      react: {
        version: 'detect',
      },
    },
  },
  {
    files: ['apps/desktop/src/**/*.{ts,tsx,js,jsx}'],
    rules: {
      'no-alert': 'error',
    },
  },
  {
    files: ['apps/desktop/electron/**/*.{ts,js}'],
    rules: {
      'no-restricted-properties': ['error',
        { object: 'dialog', property: 'showMessageBox', message: 'Use requestAppDialog so confirmations use Mira UI.' },
        { object: 'dialog', property: 'showMessageBoxSync', message: 'Use Mira site interactions for page dialogs.' },
        { object: 'dialog', property: 'showErrorBox', message: 'Use requestAppDialog so alerts use Mira UI.' },
      ],
    },
  },
  prettier,
];
