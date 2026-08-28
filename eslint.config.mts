import eslint from '@eslint/js';
import obsidianmd from 'eslint-plugin-obsidianmd';
import sonarjs from 'eslint-plugin-sonarjs';
import globals from 'globals';
import tseslint from 'typescript-eslint';
// eslint-plugin-obsidianmd requires @eslint/js ^9.30.1, so eslint v10 is blocked

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...obsidianmd.configs.recommendedWithLocalesEn,
  sonarjs.configs.recommended,
  {
    languageOptions: {
      // Obsidian plugins run in Electron — both browser and Node.js globals available
      globals: { ...globals.browser, ...globals.node },
      parserOptions: {
        projectService: {
          allowDefaultProject: ['*.js', '*.mjs', '*.mts'],
        },
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/require-await': 'warn',
      'sonarjs/cognitive-complexity': ['error', 30],
      // Redundant with @typescript-eslint/no-unused-vars
      'sonarjs/no-unused-vars': 'off',
      // MCP/Obsidian deprecations are out of scope to address
      'sonarjs/deprecation': 'off',
    },
  },
  {
    // Relax type-unsafe rules in test files — vi matchers (expect.objectContaining etc.) return any
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
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
          paths: [
            {
              name: '../../tasks',
              importNames: ['Clock', 'systemClock', 'systemCommentTimeContext'],
              message: 'Project inspector time must be injected by composition.',
            },
          ],
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
    ignores: ['dist/', 'node_modules/', 'main.js', 'esbuild.config.mjs', 'version-bump.mjs'],
  },
);
