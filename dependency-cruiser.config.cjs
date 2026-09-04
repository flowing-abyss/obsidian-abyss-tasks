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
      name: 'task-infrastructure-depends-inward',
      comment: 'Task infrastructure may depend only on inward task layers, Markdown, and Obsidian.',
      severity: 'error',
      from: { path: '^src/tasks/infrastructure/' },
      to: {
        pathNot: [
          '^src/tasks/(?:infrastructure|application|domain)/',
          '^src/markdown/',
          '^obsidian$',
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
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    moduleSystems: ['es6'],
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: 'specify',
    enhancedResolveOptions: { conditionNames: ['types', 'import', 'node', 'default'] },
  },
};
