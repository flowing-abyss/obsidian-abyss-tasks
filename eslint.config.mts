import json from '@eslint/json';
import prettier from 'eslint-config-prettier';
import obsidianmd from 'eslint-plugin-obsidianmd';
import { PlainTextParser } from 'eslint-plugin-obsidianmd/dist/lib/plainTextParser.js';
import sonarjs from 'eslint-plugin-sonarjs';
import { defineConfig, globalIgnores } from 'eslint/config';
import * as globals from 'globals';
import tseslint from 'typescript-eslint';

const testFiles = ['test/**/*.ts', 'vitest.config.ts', 'vitest.bench.config.ts'];
const metadataIncompatibleRules = Object.fromEntries(
  [
    ...new Set(
      obsidianmd.configs.recommendedWithLocalesEn.flatMap((config) =>
        Object.keys(config.rules ?? {}).filter((rule) => !rule.includes('/')),
      ),
    ),
    ...Object.keys(sonarjs.configs.recommended.rules as Readonly<Record<string, unknown>>),
  ].map((rule) => [rule, 'off'] as const),
);

export default defineConfig(
  globalIgnores([
    'node_modules',
    'dist',
    'coverage',
    'esbuild.config.mjs',
    'version-bump.mjs',
    'versions.json',
    'main.js',
    'pnpm-lock.yaml',
    'tsconfig.json',
    '.ai',
    '.agents',
    '.a5c',
    '.agent',
    '.claude',
    '.codegraph',
    '.codex',
    '.cursor',
    '.forge',
    '.gemini',
    '.opencode',
    '.pi-lens',
    '.pi',
    '.serena',
    '.superpowers',
    '.worktrees',
    '.zed',
    'dev-vault-tasks',
    'docs',
  ]),
  {
    languageOptions: {
      globals: {
        ...globals.browser,
      },
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            'eslint.config.mts',
            'manifest.json',
            'commitlint.config.mjs',
            'dependency-cruiser.config.cjs',
            'stylelint.config.mjs',
            'release-check.mjs',
            'release-artifacts.mjs',
          ],
        },
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: ['.json'],
      },
    },
  },
  ...obsidianmd.configs.recommendedWithLocalesEn,
  sonarjs.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      // Complexity budgets (cyclomatic + cognitive), mirrors the reference TypeScript template.
      complexity: ['error', 10],
      'sonarjs/cognitive-complexity': ['error', 10],
      'max-depth': ['error', 4],
      'max-lines-per-function': ['error', { max: 80, skipBlankLines: true, skipComments: true }],
      'max-params': ['error', 4],
      'max-statements': ['error', 30],

      'array-callback-return': 'error',
      curly: ['error', 'all'],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-else-return': ['error', { allowElseIf: false }],
      'no-new-wrappers': 'error',
      'no-param-reassign': 'error',
      'no-throw-literal': 'error',
      'no-unused-vars': 'off',
      'object-shorthand': ['error', 'always'],
      'prefer-const': ['error', { destructuring: 'all', ignoreReadBeforeAssign: false }],
      'prefer-template': 'error',
      'require-atomic-updates': 'error',

      '@typescript-eslint/array-type': ['error', { default: 'array-simple' }],
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-check': false,
          'ts-expect-error': 'allow-with-description',
          'ts-ignore': true,
          'ts-nocheck': true,
          minimumDescriptionLength: 12,
        },
      ],
      '@typescript-eslint/consistent-type-exports': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/explicit-function-return-type': [
        'error',
        {
          allowExpressions: true,
          allowHigherOrderFunctions: true,
          allowTypedFunctionExpressions: true,
        },
      ],
      '@typescript-eslint/no-confusing-void-expression': [
        'error',
        { ignoreArrowShorthand: false, ignoreVoidOperator: false },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': [
        'error',
        { ignoreIIFE: false, ignoreVoid: false },
      ],
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: true }],
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-redundant-type-constituents': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/only-throw-error': 'error',
      '@typescript-eslint/prefer-nullish-coalescing': 'error',
      '@typescript-eslint/prefer-optional-chain': 'error',
      '@typescript-eslint/prefer-readonly': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/strict-boolean-expressions': [
        'error',
        { allowString: false, allowNumber: false, allowNullableObject: false },
      ],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
    },
  },
  {
    files: testFiles,
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      'max-lines-per-function': 'off',
      'max-statements': 'off',
      'sonarjs/cognitive-complexity': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
    },
  },
  {
    files: ['src/tasks/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^(?!\\./)',
              message: 'Task domain may import only sibling domain modules.',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date']",
          message: 'Task domain receives time through explicit values or a Clock port.',
        },
        {
          selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message: 'Task domain receives time through explicit values or a Clock port.',
        },
        {
          selector: "CallExpression[callee.name='Date']",
          message: 'Task domain receives time through explicit values or a Clock port.',
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'window', message: 'Task domain cannot depend on browser ambient state.' },
        { name: 'document', message: 'Task domain cannot depend on browser ambient state.' },
      ],
    },
  },
  {
    files: ['src/tasks/domain/recurrence.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^(?!\\./|rrule$)',
              message:
                'The recurrence engine may import only sibling domain modules and the deterministic rrule boundary.',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date'][arguments.length!=1]",
          message:
            'The recurrence engine may construct Date only from one explicit UTC-derived value.',
        },
        {
          selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message: 'Task domain receives time through explicit values or a Clock port.',
        },
        {
          selector: "CallExpression[callee.name='Date']",
          message: 'Task domain receives time through explicit values or a Clock port.',
        },
      ],
    },
  },
  {
    files: ['src/tasks/application/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^(?!\\./|\\.\\./domain/)',
              message:
                'Task application may depend only on domain contracts and application ports.',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date']",
          message: 'Task application receives time through its Clock port.',
        },
        {
          selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message: 'Task application receives time through its Clock port.',
        },
        {
          selector: "CallExpression[callee.name='Date']",
          message: 'Task application receives time through its Clock port.',
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'window', message: 'Task application cannot depend on browser ambient state.' },
        { name: 'document', message: 'Task application cannot depend on browser ambient state.' },
      ],
    },
  },
  {
    files: ['src/tasks/infrastructure/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'obsidian',
              importNames: ['Notice'],
              message: 'Task infrastructure returns structured results; presentation owns Notice.',
            },
          ],
          patterns: [
            {
              regex: '^(?:\\.\\.?/)+(?:panels|ui|views)(?:/|$)',
              message: 'Task infrastructure must not depend on presentation modules.',
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      'src/code-block/**/*.ts',
      'src/panels/**/*.ts',
      'src/ui/**/*.ts',
      'src/views/**/*.ts',
      'src/settings/SettingsTab.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^(?:\\.\\.?/)+tasks/(?:application|domain|infrastructure)(?:/|$)',
              message: 'Presentation imports task contracts only through src/tasks/index.ts.',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[property.name='process']",
          message:
            'Presentation sends task commands through TaskApplicationApi; it does not write.',
        },
        {
          selector: "MemberExpression[computed=true][property.value='process']",
          message:
            'Presentation sends task commands through TaskApplicationApi; it does not write.',
        },
      ],
    },
  },
  {
    // Node-only tooling scripts are not part of the browser-context plugin bundle.
    files: [
      '*.cjs',
      'release-check.mjs',
      'release-artifacts.mjs',
      'test/dependency-rules.test.ts',
      'test/release-artifacts.test.ts',
    ],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      'obsidianmd/no-nodejs-modules': 'off',
      'obsidianmd/rule-custom-message': 'off',
      'no-console': 'off',
      'no-undef': 'off',
    },
  },
  {
    files: ['package.json'],
    language: 'json/json',
    plugins: { json },
    rules: {
      ...metadataIncompatibleRules,
      ...json.configs.recommended.rules,
    },
  },
  {
    files: ['manifest.json'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: false,
        extraFileExtensions: ['.json'],
      },
    },
    plugins: { obsidianmd },
    rules: {
      ...metadataIncompatibleRules,
      'obsidianmd/validate-manifest': 'error',
    },
  },
  {
    files: ['LICENSE'],
    languageOptions: { parser: PlainTextParser },
    plugins: { obsidianmd },
    rules: {
      ...metadataIncompatibleRules,
      'obsidianmd/validate-license': 'error',
    },
  },
  prettier,
);
