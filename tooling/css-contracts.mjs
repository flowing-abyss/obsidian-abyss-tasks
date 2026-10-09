/** Official docs as of the 1.7.2 release day: documentation evidence, not execution of an old binary. */
const historicalCommit = 'cc385fedfa8ba84a8909c71850b26b1b4e277616';
const documented = {
  'Foundations/Colors.md': [
    '--accent-h',
    '--accent-l',
    '--accent-s',
    '--background-modifier-active-hover',
    '--background-modifier-border',
    '--background-modifier-border-focus',
    '--background-modifier-border-hover',
    '--background-modifier-error',
    '--background-modifier-form-field',
    '--background-modifier-hover',
    '--background-primary-alt',
    '--background-secondary-alt',
    '--color-blue',
    '--color-green',
    '--color-orange',
    '--color-purple',
    '--color-red',
    '--color-red-rgb',
    '--color-yellow',
    '--interactive-accent',
    '--interactive-accent-hover',
    '--interactive-hover',
    '--interactive-normal',
    '--text-accent',
    '--text-error',
    '--text-faint',
    '--text-highlight-bg',
    '--text-muted',
    '--text-normal',
    '--text-on-accent',
    '--text-warning',
  ],
  'About styling.md': ['--background-primary', '--background-secondary'],
  'Components/Checkbox.md': ['--checkbox-size'],
  'Window/Divider.md': ['--divider-color'],
  'Foundations/Typography.md': [
    '--font-medium',
    '--font-normal',
    '--font-semibold',
    '--font-smallest',
    '--font-ui-medium',
    '--font-ui-small',
    '--font-ui-smaller',
    '--line-height-normal',
    '--line-height-tight',
    '--font-interface-theme',
    '--font-text-theme',
    '--font-monospace-theme',
  ],
  'Foundations/Icons.md': ['--icon-color', '--icon-color-active'],
  'Components/Text input.md': ['--input-height'],
  'Foundations/Layers.md': ['--layer-menu', '--layer-popover'],
  'Editor/Link.md': ['--link-color'],
  'Components/Navigation.md': [
    '--nav-item-background-active',
    '--nav-item-background-hover',
    '--nav-item-color',
    '--nav-item-color-active',
    '--nav-item-color-hover',
  ],
  'Foundations/Radiuses.md': ['--radius-l', '--radius-m', '--radius-s'],
  'Foundations/Spacing.md': [
    '--size-2-1',
    '--size-2-2',
    '--size-2-3',
    '--size-4-1',
    '--size-4-12',
    '--size-4-16',
    '--size-4-2',
    '--size-4-3',
    '--size-4-4',
    '--size-4-5',
    '--size-4-6',
    '--size-4-8',
    '--size-4-9',
    '--size-4-18',
  ],
  'Editor/Tag.md': ['--tag-background', '--tag-color'],
};
/** @type {import('./css-policy.mjs').CssContracts['core']} */
const core = Object.fromEntries(
  Object.entries(documented).flatMap(([document, names]) =>
    names.map((name) => [
      name,
      {
        minimum: true,
        source: `https://github.com/obsidianmd/obsidian-developer-docs/blob/${historicalCommit}/en/Reference/CSS variables/${document}`,
      },
    ]),
  ),
);
Object.assign(core, {
  '--highlight-background': {
    source:
      'Obsidian Default CSSOM, 2026-10-06; `.search-result-file-matched-text` uses background-color: var(--highlight-background), whose host definition is var(--text-highlight-bg, var(--highlight-background-yellow)). No minimum-runtime proof.',
    minimum: false,
    fallback: 'var(--text-highlight-bg)',
  },
  '--font-interface': {
    source:
      'Obsidian 1.13.7 Default CSSOM, 2026-09-20; no minimum-runtime proof. Native font/semantic fallback; optional shadows may safely disappear.',
    minimum: false,
    fallback: 'var(--font-interface-theme)',
  },
  '--font-text': {
    source:
      'Obsidian 1.13.7 Default CSSOM, 2026-09-20; no minimum-runtime proof. Native font/semantic fallback; optional shadows may safely disappear.',
    minimum: false,
    fallback: 'var(--font-text-theme)',
  },
  '--font-monospace': {
    source:
      'Obsidian 1.13.7 Default CSSOM, 2026-09-20; no minimum-runtime proof. Native font/semantic fallback; optional shadows may safely disappear.',
    minimum: false,
    fallback: 'var(--font-monospace-theme)',
  },
  '--shadow-s': {
    source:
      'Obsidian 1.13.7 Default CSSOM, 2026-09-20; no minimum-runtime proof. Native font/semantic fallback; optional shadows may safely disappear.',
    minimum: false,
    fallback: 'none',
  },
  '--shadow-l': {
    source:
      'Obsidian 1.13.7 Default CSSOM, 2026-09-20; no minimum-runtime proof. Native font/semantic fallback; optional shadows may safely disappear.',
    minimum: false,
    fallback: 'none',
  },
  '--color-accent': {
    source:
      'Obsidian 1.13.7 Default CSSOM, 2026-09-20; no minimum-runtime proof. Native font/semantic fallback; optional shadows may safely disappear.',
    minimum: false,
    fallback: 'var(--interactive-accent)',
  },
  '--background-modifier-cover': {
    source:
      'Obsidian 1.13.7 Default CSSOM, 2026-09-20; no minimum-runtime proof. Native font/semantic fallback; optional shadows may safely disappear.',
    minimum: false,
    fallback: 'var(--background-primary)',
  },
  '--view-bottom-spacing': {
    source:
      'Obsidian 1.13.7 app.css `.is-phone.is-floating-nav, .is-phone.auto-full-screen` block, 2026-09-22; the reservation Obsidian gives its own views under the floating phone navigation. Absent when the navigation is not floating, so zero is the correct fallback.',
    minimum: false,
    fallback: '0px',
  },
});

/** @type {import('./css-policy.mjs').CssContracts} */
export const contracts = {
  core,
  spacing: {
    '2px': '--size-2-1',
    '4px': '--size-4-1',
    '6px': '--size-2-3',
    '8px': '--size-4-2',
    '12px': '--size-4-3',
    '16px': '--size-4-4',
    '20px': '--size-4-5',
    '24px': '--size-4-6',
    '32px': '--size-4-8',
    '36px': '--size-4-9',
    '48px': '--size-4-12',
    '64px': '--size-4-16',
    '72px': '--size-4-18',
  },
  runtime: {
    // Exact native spacer producer/consumer is exercised by css-policy.test.ts.
    produced: [
      '--abyss-virtual-row-height',
      '--abyss-virtual-row-offset',
      '--abyss-virtual-row-width',
      '--abyss-project-kanban-spacer-height',
      '--abyss-project-timeline-spacer-height',
    ],
    // The pinned external DOM host reads only these documented inputs inside our local tooltip.
    // https://github.com/TanStack/charts/blob/v1.0.0/docs/reference/focus-and-interaction.md#css-variables
    consumed: [
      '--abyss-tag-text-light',
      '--abyss-tag-text-dark',
      '--ts-chart-tooltip-background',
      '--ts-chart-tooltip-color',
      '--ts-chart-tooltip-border',
      '--ts-chart-tooltip-border-radius',
      '--ts-chart-tooltip-shadow',
      '--ts-chart-tooltip-max-width',
      '--ts-chart-tooltip-padding',
      '--ts-chart-tooltip-font',
    ],
  },
  exceptions: [
    {
      ruleId: 'abyss/token-color',
      selector: '.abyss-panel-view',
      property: '--abyss-tag-text-light',
      value: '#f5f5f5',
      context: [],
      reason:
        'Fixed contrast anchor for runtime luminance-based tag text choice, independent of theme text colors.',
    },
    {
      ruleId: 'abyss/token-color',
      selector: '.abyss-panel-view',
      property: '--abyss-tag-text-dark',
      value: '#161616',
      context: [],
      reason:
        'Fixed contrast anchor for runtime luminance-based tag text choice, independent of theme text colors.',
    },
  ],
};
// Finite wrappers, scoped to their source owners. Contract tests execute/discover each family.
export const runtimeFamilies = [
  {
    file: 'src/panels/statistics/StatisticsSections.ts',
    helper: 'setStatisticsKey',
    prefix: '--abyss-statistics-key-',
  },
  { file: 'src/ui/anchoredPopover.ts', helper: 'setLength', prefix: '--abyss-pop-' },
  {
    file: 'src/panels/right/InspectorPlanningSurfaces.ts',
    helper: 'setPopoverLength',
    prefix: '--abyss-pop-',
  },
  { file: 'src/ui/ViewOptionsPopover.ts', helper: 'setPopoverVariable', prefix: '' },
];
