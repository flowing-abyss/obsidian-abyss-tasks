/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      comment:
        'Import cycles are hard to spot in a diff and easy to introduce as src/ grows past main.ts.',
      severity: 'error',
      from: {},
      to: {
        circular: true,
        preCompilationOnly: false,
        viaOnly: { dependencyTypesNot: ['type-only'] },
      },
    },
    {
      name: 'no-unlisted-dependencies',
      comment:
        'Catches an import that only resolved because a transitive dependency happened to hoist it.',
      severity: 'error',
      from: {},
      to: { dependencyTypes: ['npm-no-pkg'] },
    },
    {
      name: 'task-domain-is-pure',
      comment: 'Task domain may depend only on itself and the deterministic rrule boundary.',
      severity: 'error',
      from: { path: '^src/tasks/domain/' },
      to: {
        pathNot: [
          '^src/tasks/domain/',
          '^src/markdown/tagSyntax[.]ts$',
          '^rrule$',
          '^node_modules/rrule/',
          '^node_modules/[.]pnpm/rrule@',
        ],
      },
    },
    {
      name: 'task-application-depends-inward',
      comment: 'Task application may depend only on application ports and domain contracts.',
      severity: 'error',
      from: { path: '^src/tasks/application/' },
      to: { pathNot: '^src/tasks/(?:application|domain)/' },
    },
    {
      name: 'browser-task-scheduler-is-neutral',
      comment:
        'The explicit-owner scheduling primitive imports no task, host, panel or Node authority.',
      severity: 'error',
      from: { path: '^src/browserTaskScheduler[.]ts$' },
      to: { path: '.' },
    },
    {
      name: 'task-browser-scheduler-adapter',
      comment:
        'Only the existing browser backend adapter bridges the neutral root scheduler to inward search outcomes.',
      severity: 'error',
      from: { path: '^src/tasks/infrastructure/search/BrowserTaskSearchBackend[.]ts$' },
      to: {
        pathNot: [
          '^src/tasks/(?:infrastructure|application|domain)/',
          '^src/markdown/',
          '^obsidian$',
          '^src/browserTaskScheduler[.]ts$',
        ],
      },
    },
    {
      name: 'task-infrastructure-depends-inward',
      comment: 'Task infrastructure may depend only on inward task layers, Markdown, and Obsidian.',
      severity: 'error',
      from: {
        path: '^src/tasks/infrastructure/',
        pathNot:
          '^src/tasks/infrastructure/search/(?:MiniSearchTaskEngine|BrowserTaskSearchBackend)[.]ts$',
      },
      to: {
        pathNot: [
          '^src/tasks/(?:infrastructure|application|domain)/',
          '^src/markdown/',
          '^obsidian$',
        ],
      },
    },
    {
      name: 'task-search-engine-depends-inward',
      comment: 'Only the disposable search engine may acquire the pinned MiniSearch index.',
      severity: 'error',
      from: { path: '^src/tasks/infrastructure/search/MiniSearchTaskEngine[.]ts$' },
      to: {
        pathNot: [
          '^src/tasks/(?:infrastructure|application|domain)/',
          '^src/markdown/',
          '^obsidian$',
          '^minisearch$',
          '^(?:[.][.]/)*node_modules/minisearch/',
          '^(?:[.][.]/)*node_modules/[.]pnpm/minisearch@',
        ],
      },
    },
    {
      name: 'task-presentation-uses-public-entry',
      comment: 'Presentation imports task contracts only through src/tasks/index.ts.',
      severity: 'error',
      from: {
        path: ['^src/(?:code-block|panels|ui|views)/', '^src/settings/SettingsTab\\.ts$'],
      },
      to: { path: '^src/tasks/', pathNot: '^src/tasks/index\\.ts$' },
    },
    {
      name: 'markdown-imports-no-task-layer',
      comment:
        'Markdown helpers serve task infrastructure and presentation, so they import no task layer.',
      severity: 'error',
      from: { path: '^src/markdown/' },
      to: { path: '^src/tasks/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    moduleSystems: ['es6'],
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: 'specify',
    enhancedResolveOptions: { conditionNames: ['types', 'import', 'node', 'default'] },
  },
};
