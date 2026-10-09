import { Platform } from 'obsidian';
import stylelint from 'stylelint';
import { describe, expect, it } from 'vitest';
import {
  statisticsNumber,
  statisticsSeriesOpacity,
  statisticsSeriesPaint,
} from '../src/panels/statistics/statisticsFormat';
import { contracts } from '../tooling/css-contracts.mjs';
import { analyzeCss, discoverRuntimeVariables } from '../tooling/css-policy.mjs';
import { CHILD_PROCESS_TIMEOUT_MS } from './support/timeouts';

const fixtureContracts = { ...contracts, exceptions: [], runtime: { produced: [], consumed: [] } };
const analyze = (css: string) =>
  analyzeCss(css, { file: 'fixture.css', contracts: fixtureContracts });

describe('nested image color policy', () => {
  it.each([
    ['mask-image', 'linear-gradient(red, transparent)'],
    ['list-style-image', 'linear-gradient(red, transparent)'],
    ['mask-image', 'repeating-linear-gradient(red, transparent)'],
    ['mask-image', 'radial-gradient(red, transparent)'],
    ['mask-image', 'repeating-radial-gradient(red, transparent)'],
    ['mask-image', 'conic-gradient(red, transparent)'],
    ['mask-image', 'repeating-conic-gradient(red, transparent)'],
    ['list-style-image', 'image(url("red"), red)'],
    ['content', 'linear-gradient(red, transparent)'],
    ['mask-image', 'linear-gradient(var(--text-normal, red), transparent)'],
    ['mask-image', 'linear-gradient(color-mix(in srgb, var(--text-normal), red), transparent)'],
  ])('rejects named colors inside %s: %s', (property, value) => {
    expect(analyze(`.abyss-x { ${property}: ${value}; }`).map((x) => x.ruleId)).toEqual([
      'abyss/token-color',
    ]);
  });

  it('keeps the nested named-color diagnostic at its authored source span', () => {
    expect(analyze('.abyss-x {\n  mask-image: linear-gradient(red, transparent);\n}')).toEqual([
      expect.objectContaining({ ruleId: 'abyss/token-color', line: 2, column: 31 }),
    ]);
  });

  it('accepts derived image colors and keeps URLs, strings and unrelated identifiers opaque', () => {
    expect(
      analyze(
        '.abyss-x { mask-image: linear-gradient(var(--text-normal), currentColor, transparent); list-style-image: image(url(red), var(--text-normal)); content: "linear-gradient(red, blue)"; font-family: red; animation-name: blue; background-image: url("linear-gradient(red, blue)"); }',
      ),
    ).toEqual([]);
  });
});

describe('case-insensitive standard spacing properties', () => {
  it.each([
    ['padding', 21],
    ['PADDING', 21],
    ['PaDdInG', 21],
    ['padding-inline-start', 34],
    ['PaDdInG-InLiNe-StArT', 34],
    ['margin', 20],
    ['MARGIN', 20],
    ['MaRgIn-BlOcK', 26],
    ['gap', 17],
    ['GAP', 17],
    ['row-gap', 21],
    ['RoW-GaP', 21],
    ['column-gap', 24],
    ['CoLuMn-GaP', 24],
  ])('rejects exact-scale literals in %s without shifting their span', (property, column) => {
    expect(analyze(`.abyss-x { ${property}: 8px; }`)).toEqual([
      expect.objectContaining({ ruleId: 'abyss/scale-spacing', line: 1, column }),
    ]);
    expect(analyze(`.abyss-x { ${property}: var(--size-4-2); }`)).toEqual([]);
  });

  it('preserves custom-property spelling and does not classify custom names as standard spacing', () => {
    expect(analyze('.abyss-x { --abyss-PADDING: 8px; PADDING: var(--abyss-PADDING); }')).toEqual(
      [],
    );
    expect(
      analyze('.abyss-x { --abyss-PADDING: 8px; PADDING: var(--abyss-padding); }').map(
        (x) => x.ruleId,
      ),
    ).toEqual(['abyss/known-variable', 'abyss/unused-variable']);
  });
});

describe('combined installed Stylelint and analyzer gate', () => {
  it.each([
    ['mask-image: linear-gradient(red, transparent)', 'abyss/token-color'],
    ['list-style-image: linear-gradient(red, transparent)', 'abyss/token-color'],
    ['mask-image: linear-gradient(var(--text-normal, red), transparent)', 'abyss/token-color'],
    ['PADDING: 8px', 'abyss/scale-spacing'],
    ['MaRgIn: 8px', 'abyss/scale-spacing'],
    ['RoW-GaP: 8px', 'abyss/scale-spacing'],
  ])('rejects the policy escape %s', async (declaration, ruleId) => {
    const code = `.abyss-x { ${declaration}; }`;
    const result = await stylelint.lint({ code, configFile: 'stylelint.config.mjs' });
    expect(result.results.flatMap((x) => x.warnings)).toEqual([]);
    expect(analyze(code).map((x) => x.ruleId)).toEqual([ruleId]);
  });

  it('accepts token-derived images and spacing through both installed gates', async () => {
    const code = `.abyss-x {
  mask-image: linear-gradient(var(--text-normal), currentcolor, transparent);
  list-style-image: url("red");
  padding: var(--size-4-2);
  margin: var(--size-4-2);
  row-gap: var(--size-4-2);
  content: "red";
}`;
    const result = await stylelint.lint({ code, configFile: 'stylelint.config.mjs' });
    expect(result.results.flatMap((x) => x.warnings)).toEqual([]);
    expect(analyze(code)).toEqual([]);
  });
});

describe('CSS policy', () => {
  it('reports unknown variables at the actual var name, including nested fallbacks', () => {
    expect(analyze('.abyss-x {\n  color: var(--text-nromal);\n}')).toEqual([
      expect.objectContaining({
        ruleId: 'abyss/known-variable',
        file: 'fixture.css',
        line: 2,
        column: 14,
      }),
    ]);
    expect(
      analyze('.abyss-x { color: var(--text-normal, var(--typo)); }').map((x) => x.ruleId),
    ).toEqual(['abyss/known-variable']);
    expect(analyze('.abyss-x { color: var(--text-normal); }')).toEqual([]);
  });

  it.each([
    ['.abyss-a, .setting-item { color: currentColor; }', true],
    [':is(.abyss-a, body) .x { color: currentColor; }', true],
    ['.is-dragging:not(.abyss-a) { opacity: .5; }', true],
    ['.not-abyss-a { opacity: .5; }', true],
    ['.abyss-a + .setting-item { opacity: .5; }', true],
    ['.abyss-a ~ body .setting-item { opacity: .5; }', true],
    ['body:has(.abyss-a) { opacity: .5; }', true],
    [':where(.abyss-a, .abyss-b) .x { color: currentColor; }', false],
    ['body .abyss-a:hover > .child + .sibling { opacity: .5; }', false],
    ['.abyss-a + .abyss-b { opacity: .5; }', false],
    ['.abyss-a:not(.setting-item) { opacity: .5; }', false],
    [':is(.abyss-a .x) + .sibling { color: var(--text-normal); }', false],
    [':where(.abyss-a .x, .abyss-b > .y) ~ .sibling { color: currentColor; }', false],
    [':is(:where(.abyss-a .x)) + .sibling { color: currentColor; }', false],
    [':is(.abyss-a .x, .abyss-b) > .child + .sibling { color: currentColor; }', false],
    [':is(.abyss-a .x, .abyss-b) + .sibling { color: currentColor; }', true],
    [':where(.abyss-a, .abyss-b) ~ .sibling { color: currentColor; }', true],
    [':is(.abyss-a .x, body .x) + .sibling { color: currentColor; }', true],
    [':is(.abyss-a + .x) + .sibling { color: currentColor; }', true],
    [':is(.abyss-a .x) + .sibling, .outside { color: currentColor; }', true],
    [
      '@keyframes pulse { from { opacity: 0; } to { opacity: 1; } } .abyss-a { animation: pulse 1s; }',
      false,
    ],
  ])('constrains every selector branch: %s', (css, rejected) => {
    expect(analyze(css).some((x) => x.ruleId === 'abyss/selector-scope')).toBe(rejected);
  });

  it.each([
    'color-mix(in srgb, var(--text-normal), rgb(255 0 0))',
    'linear-gradient(var(--text-normal), #fff)',
    'var(--text-normal, rebeccapurple)',
    'light-dark(white, black)',
  ])('rejects nested literal colors: %s', (value) => {
    expect(
      analyze(`.abyss-x { background: ${value}; }`).some((x) => x.ruleId === 'abyss/token-color'),
    ).toBe(true);
  });

  it('accepts derived colors, keywords, and ignores quoted text and URLs', () => {
    expect(
      analyze(
        '.abyss-x { color: currentColor; background: color-mix(in srgb, var(--text-normal) 50%, transparent); content: "#fff var(--typo)"; background-image: url("data:image/svg+xml,#fff"); }',
      ),
    ).toEqual([]);
  });

  it('requires a documented fallback for host tokens unverified for the minimum runtime', () => {
    expect(
      analyze('.abyss-x { font-family: var(--font-interface); }').map((x) => x.ruleId),
    ).toEqual(['abyss/compatible-variable']);
    expect(
      analyze(
        '.abyss-x { font-family: var(--font-interface, var(--font-interface-theme)); box-shadow: var(--shadow-s, none); }',
      ),
    ).toEqual([]);
    expect(
      analyze('.abyss-x { font-family: var(--font-interface, var(--text-normal)); }').map(
        (x) => x.ruleId,
      ),
    ).toEqual(['abyss/compatible-variable']);
  });

  it('finds unused owned declarations while accepting actual runtime readers', () => {
    expect(analyze('.abyss-x { --abyss-dead: 1; }').map((x) => x.ruleId)).toEqual([
      'abyss/unused-variable',
    ]);
    expect(
      analyzeCss('.abyss-x { --abyss-read: 1; }', {
        file: 'fixture.css',
        contracts: { ...fixtureContracts, runtime: { produced: [], consumed: ['--abyss-read'] } },
      }),
    ).toEqual([]);
    expect(analyze('.abyss-x { color: var(--abyss-made-up); }').map((x) => x.ruleId)).toEqual([
      'abyss/known-variable',
    ]);
  });

  it('discovers literal CSS API calls, not comments or unrelated string constants', () => {
    expect(
      discoverRuntimeVariables(
        `// el.style.setProperty('--fake', '1');\nconst unrelated = '--unused'; el.style.setProperty('--abyss-written', '1'); el.setCssProps({'--abyss-object': '2'}); el.style.getPropertyValue('--abyss-read');`,
      ),
    ).toEqual({ produced: ['--abyss-object', '--abyss-written'], consumed: ['--abyss-read'] });
  });

  it('requires exact scale spacing even in mixed calculations, without rounding geometry', () => {
    expect(
      analyze('.abyss-x { padding: calc(var(--size-4-1) + 8px); }').map((x) => x.ruleId),
    ).toEqual(['abyss/scale-spacing']);
    expect(
      analyze('.abyss-x { margin: 0 auto; padding: 3px 1em; gap: var(--size-4-2); width: 8px; }'),
    ).toEqual([]);
  });

  it('accepts only exact justified important/color identities and rejects stale or duplicate exceptions', () => {
    const exception = {
      ruleId: 'abyss/important',
      selector: '.abyss-x',
      property: 'padding',
      value: '0',
      context: [],
      reason: 'Override host panel padding.',
    };
    const options = {
      file: 'fixture.css',
      contracts: { ...fixtureContracts, exceptions: [exception] },
    };
    expect(analyzeCss('.abyss-x { padding: 0 !important; }', options)).toEqual([]);
    expect(analyzeCss('.abyss-x { padding: 0; }', options).map((x) => x.ruleId)).toEqual([
      'abyss/stale-exception',
    ]);
    expect(
      analyzeCss('.abyss-x { padding: 0 !important; }', {
        ...options,
        contracts: { ...options.contracts, exceptions: [exception, exception] },
      }).map((x) => x.ruleId),
    ).toContain('abyss/duplicate-exception');
    expect(analyze('.abyss-x { padding: 0 !important; }').map((x) => x.ruleId)).toEqual([
      'abyss/important',
    ]);
    expect(
      analyzeCss(
        '@media (prefers-reduced-motion: reduce) { .abyss-x { padding: 0 !important; } }',
        options,
      ).map((x) => x.ruleId),
    ).toContain('abyss/important');
  });

  it('keeps legitimate dynamic tag contrast anchors through their exact exception and runtime contract', () => {
    const css =
      '.abyss-panel-view { --abyss-tag-text-light: #f5f5f5; --abyss-tag-text-dark: #161616; }';
    expect(
      analyzeCss(css, {
        file: 'fixture.css',
        contracts: {
          ...contracts,
          exceptions: contracts.exceptions.filter((x) => x.ruleId === 'abyss/token-color'),
          runtime: { produced: [], consumed: ['--abyss-tag-text-light', '--abyss-tag-text-dark'] },
        },
      }),
    ).toEqual([]);
  });
});

describe('selected third-party correctness rules', () => {
  it.each([
    ['.abyss-x { position: relative; z-index: 1.5; }', 'projectwallace/no-invalid-z-index'],
    [
      '@keyframes a { to { opacity: 1; } } @keyframes a { to { opacity: 0; } } .abyss-x { animation: a 1s; }',
      'projectwallace/no-duplicate-keyframes',
    ],
    ['@keyframes a { to { opacity: 1; } }', 'projectwallace/no-unused-keyframes'],
    ['.abyss-x { container-name: unused; }', 'projectwallace/no-unused-container-names'],
    ['.abyss-x { display: inline; width: 5px; }', 'plugin/declaration-block-no-ignored-properties'],
  ])('rejects %s', async (code, rule) => {
    const result = await stylelint.lint({ code, configFile: 'stylelint.config.mjs' });
    expect(result.results.flatMap((x) => x.warnings).map((x) => x.rule)).toContain(rule);
  });

  it('accepts used containers/keyframes, variable z-index and established cascade extensions', async () => {
    const result = await stylelint.lint({
      code: '.abyss-x { display: flex; container: cards / inline-size; position: relative; z-index: var(--layer-menu); animation: pulse 1s; } .abyss-x { width: 50%; } @container cards (width > 100px) { .abyss-x { width: 100%; } } @keyframes pulse { to { opacity: 1; } }',
      configFile: 'stylelint.config.mjs',
    });
    expect(
      result.results
        .flatMap((x) => x.warnings)
        .filter((x) => x.rule.startsWith('projectwallace/') || x.rule.startsWith('plugin/')),
    ).toEqual([]);
  });
});

it(
  'CLI rejects a bad source and accepts a valid source with no output',
  { timeout: CHILD_PROCESS_TIMEOUT_MS },
  async () => {
    if (!Platform.isDesktop) throw new Error('CSS CLI tests require desktop');
    const [{ spawnSync }, fs, os, path] = await Promise.all([
      import('node:child_process'),
      import('node:fs'),
      import('node:os'),
      import('node:path'),
    ]);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'abyss-css-'));
    const file = path.join(directory, 'fixture.css');
    try {
      fs.writeFileSync(file, '.abyss-x { color: var(--text-nromal); }');
      const bad = spawnSync(process.execPath, ['tooling/check-css.mjs', file], {
        encoding: 'utf8',
      });
      expect(bad.status).toBe(1);
      expect(bad.stderr).toContain('abyss/known-variable');
      fs.writeFileSync(file, '.abyss-x { color: var(--text-normal); }');
      const good = spawnSync(process.execPath, ['tooling/check-css.mjs', file], {
        encoding: 'utf8',
      });
      expect(good.status).toBe(0);
      expect(good.stdout + good.stderr).toBe('');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);

it('does not mistake a variable alpha channel for token-derived color channels', () => {
  expect(
    analyze('.abyss-x { color: rgb(255 0 0 / var(--size-4-1)); }').map((x) => x.ruleId),
  ).toContain('abyss/token-color');
  expect(analyze('.abyss-x { padding: 8.0px; }').map((x) => x.ruleId)).toEqual([
    'abyss/scale-spacing',
  ]);
});

it('preserves exception identities through minified spacing and zero units, but rejects a changed value', () => {
  const exception = {
    ruleId: 'abyss/important',
    selector: '.abyss-x',
    property: 'left',
    value: 'max(0px, var(--size-4-1))',
    context: ['@media (width <= 900px)'],
    reason: 'Clamp native inline geometry.',
  };
  const options = {
    file: 'dist/fixture.css',
    contracts: { ...fixtureContracts, exceptions: [exception] },
  };
  expect(
    analyzeCss('@media(width<=900px){.abyss-x{left:max(0,var(--size-4-1))!important}}', options),
  ).toEqual([]);
  expect(
    analyzeCss(
      '@media(width<=900px){.abyss-x{left:max(1px,var(--size-4-1))!important}}',
      options,
    ).map((x) => x.ruleId),
  ).toEqual(['abyss/important', 'abyss/stale-exception']);
});

it('keeps descendant combinators meaningful in exception identity', () => {
  const exception = {
    ruleId: 'abyss/important',
    selector: '.abyss-x .item',
    property: 'padding',
    value: '0',
    context: [],
    reason: 'Only the child has host padding.',
  };
  const findings = analyzeCss('.abyss-x.item { padding: 0 !important; }', {
    file: 'fixture.css',
    contracts: { ...fixtureContracts, exceptions: [exception] },
  });
  expect(findings.map((x) => x.ruleId)).toEqual(['abyss/important', 'abyss/stale-exception']);
});

it('checks named colors in all color-bearing properties', () => {
  expect(
    analyze('.abyss-x { accent-color: red; column-rule: 1px solid blue; }').map((x) => x.ruleId),
  ).toEqual(['abyss/token-color', 'abyss/token-color']);
});

it('ties finite runtime producer families to calls in their actual source owners', async () => {
  const { default: ts } = await import('typescript');
  const { runtimeFamilies } = await import('../tooling/css-contracts.mjs');
  const expected: Record<string, string[]> = {
    'src/panels/statistics/StatisticsSections.ts': [
      '--abyss-statistics-key-opacity',
      '--abyss-statistics-key-paint',
    ],
    'src/ui/anchoredPopover.ts': [
      '--abyss-pop-height',
      '--abyss-pop-left',
      '--abyss-pop-top',
      '--abyss-pop-width',
    ],
    'src/panels/right/InspectorPlanningSurfaces.ts': [
      '--abyss-pop-height',
      '--abyss-pop-left',
      '--abyss-pop-top',
      '--abyss-pop-width',
    ],
    'src/ui/ViewOptionsPopover.ts': [
      '--abyss-pop-left',
      '--abyss-pop-top',
      '--abyss-view-state-max-height',
      '--abyss-view-state-max-width',
    ],
  };
  for (const family of runtimeFamilies) {
    const source = ts.sys.readFile(ts.sys.resolvePath(family.file));
    if (source === undefined) throw new Error(`Missing owner ${family.file}`);
    const direct = discoverRuntimeVariables(source).produced;
    const finite = discoverRuntimeVariables(source, [family]).produced.filter(
      (name) => !direct.includes(name),
    );
    expect(finite).toEqual(expected[family.file]);
  }
});

it('keeps the two dynamic tag text consumers tied to the real luminance choice', async () => {
  const { tagFillTextColorVar } = await import('../src/tags/tagFillContrast');
  const element = document.body.createSpan();
  const prior = document.body.style.getPropertyValue('--background-primary');
  try {
    document.body.setCssProps({ '--background-primary': '#000000' });
    expect(tagFillTextColorVar(element, '#000000')).toBe('var(--abyss-tag-text-light)');
    document.body.setCssProps({ '--background-primary': '#ffffff' });
    expect(tagFillTextColorVar(element, '#ffffff')).toBe('var(--abyss-tag-text-dark)');
    expect(contracts.runtime.consumed.filter((name) => name.startsWith('--abyss-tag-'))).toEqual([
      '--abyss-tag-text-light',
      '--abyss-tag-text-dark',
    ]);
  } finally {
    element.remove();
    if (prior === '') document.body.style.removeProperty('--background-primary');
    else document.body.style.setProperty('--background-primary', prior);
  }
});

it('checks every color channel in legacy comma-separated functions', () => {
  expect(
    analyze('.abyss-x { color: rgb(var(--color-red-rgb), 255, 0); }').map((x) => x.ruleId),
  ).toContain('abyss/token-color');
  expect(analyze('.abyss-x { color: rgba(var(--color-red-rgb), .08); }')).toEqual([]);
});

it('does not collapse significant whitespace inside exception strings', () => {
  const exception = {
    ruleId: 'abyss/important',
    selector: '.abyss-x',
    property: 'content',
    value: '"a b"',
    context: [],
    reason: 'Fixture tests exact string identity.',
  };
  expect(
    analyzeCss('.abyss-x { content: "ab" !important; }', {
      file: 'fixture.css',
      contracts: { ...fixtureContracts, exceptions: [exception] },
    }).map((x) => x.ruleId),
  ).toEqual(['abyss/important', 'abyss/stale-exception']);
});

it('reports actionable spans for scope, color, important and spacing findings', () => {
  const findings = analyze('.outside {\n color: red;\n padding: 8px !important;\n}');
  expect(findings.map(({ ruleId, line, column }) => ({ ruleId, line, column }))).toEqual([
    { ruleId: 'abyss/selector-scope', line: 1, column: 1 },
    { ruleId: 'abyss/token-color', line: 2, column: 9 },
    { ruleId: 'abyss/important', line: 3, column: 2 },
    { ruleId: 'abyss/scale-spacing', line: 3, column: 11 },
  ]);
});

describe('filter shadow color policy', () => {
  it.each([
    ['filter', 31],
    ['backdrop-filter', 40],
    ['FILTER', 31],
    ['Backdrop-Filter', 40],
    ['-WEBKIT-FILTER', 39],
    ['-WebKit-Backdrop-Filter', 48],
  ])('rejects named shadow colors in %s at their source span', (property, column) => {
    const css = `.abyss-x {\n  ${property}: drop-shadow(0 0 2px red);\n}`;
    expect(analyze(css)).toEqual([
      expect.objectContaining({
        ruleId: 'abyss/token-color',
        file: 'fixture.css',
        line: 2,
        column,
      }),
    ]);
  });

  it('rejects named colors nested in a shadow fallback and color mix', () => {
    const css =
      '.abyss-x { filter: drop-shadow(0 0 2px color-mix(in srgb, var(--text-normal, red), blue)); }';
    expect(analyze(css).map(({ ruleId }) => ruleId)).toEqual([
      'abyss/token-color',
      'abyss/token-color',
    ]);
  });

  it.each([
    'filter',
    'backdrop-filter',
    'FILTER',
    'Backdrop-Filter',
    '-WEBKIT-FILTER',
    '-WebKit-Backdrop-Filter',
  ])('accepts host-derived and currentColor shadows in %s', (property) => {
    expect(
      analyze(
        `.abyss-x { ${property}: drop-shadow(0 0 2px var(--text-normal)) drop-shadow(0 0 1px currentColor); }`,
      ),
    ).toEqual([]);
  });

  it('ignores color words in filter URLs and quoted text', () => {
    expect(
      analyze(
        '.abyss-x { filter: url(red) url("blue"); backdrop-filter: url("data:image/svg+xml,red"); content: "drop-shadow(0 0 2px red)"; }',
      ),
    ).toEqual([]);
  });
});

it('preserves case-sensitive custom-property identities while checking filter property names', () => {
  expect(
    analyze(
      '.abyss-x { --abyss-Shadow: currentColor; FILTER: drop-shadow(0 0 2px var(--abyss-Shadow)); }',
    ),
  ).toEqual([]);
  expect(
    analyze(
      '.abyss-x { --abyss-Shadow: currentColor; FILTER: drop-shadow(0 0 2px var(--abyss-shadow)); }',
    ).map(({ ruleId }) => ruleId),
  ).toEqual(['abyss/known-variable', 'abyss/unused-variable']);
});

it('keeps compact range geometry CSS-owned without allowing forced bar overrides', () => {
  const options = {
    file: 'fixture.css',
    contracts: {
      ...fixtureContracts,
      runtime: { produced: ['--abyss-project-timeline-range-left'], consumed: [] },
      exceptions: contracts.exceptions.filter((entry) =>
        entry.selector.startsWith('.abyss-project-timeline-bar'),
      ),
    },
  };
  expect(
    analyzeCss(
      '.abyss-project-timeline-bar { left: max(0px, min(var(--abyss-project-timeline-range-left), 100% - 40px)); min-width: 40px; }',
      options,
    ),
  ).toEqual([]);
  expect(
    analyzeCss('.abyss-project-timeline-bar.is-one-date { width: 0 !important; }', options).map(
      ({ ruleId }) => ruleId,
    ),
  ).toContain('abyss/important');
});

it('discovers the range coordinate from its real source owner', async () => {
  const { default: ts } = await import('typescript');
  const source = ts.sys.readFile(
    ts.sys.resolvePath('src/panels/projects/projectTimelineInteraction.ts'),
  );
  if (source === undefined) throw new Error('Missing Timeline interaction owner');
  const runtime = discoverRuntimeVariables(source);
  expect(runtime.produced).toContain('--abyss-project-timeline-range-left');
  expect(
    analyzeCss('.abyss-project-timeline-bar { left: var(--abyss-project-timeline-range-left); }', {
      file: 'fixture.css',
      contracts: { ...fixtureContracts, runtime },
    }),
  ).toEqual([]);
});

describe('Statistics semantic paint contracts', () => {
  it('enrolls exactly the documented external tooltip consumers and rejects unknown variables', async () => {
    const names = [
      '--ts-chart-tooltip-background',
      '--ts-chart-tooltip-color',
      '--ts-chart-tooltip-border',
      '--ts-chart-tooltip-border-radius',
      '--ts-chart-tooltip-shadow',
      '--ts-chart-tooltip-max-width',
      '--ts-chart-tooltip-padding',
      '--ts-chart-tooltip-font',
    ];
    expect(
      contracts.runtime.consumed.filter((name) => name.startsWith('--ts-chart-tooltip-')),
    ).toEqual(names);
    const { default: ts } = await import('typescript');
    const css = ts.sys.readFile(ts.sys.resolvePath('styles.css'));
    if (css === undefined) throw new Error('Missing Statistics surface styles');
    for (const name of names) expect(css).toContain(`${name}:`);
    expect(
      analyzeCss('.abyss-statistics { --ts-chart-tooltip-color: var(--text-normal); }', {
        file: 'fixture.css',
        contracts: { ...fixtureContracts, runtime: contracts.runtime },
      }),
    ).toEqual([]);
    expect(
      analyzeCss('.abyss-statistics { color: var(--ts-chart-tooltip-unknown); }', {
        file: 'fixture.css',
        contracts: { ...fixtureContracts, runtime: contracts.runtime },
      }).map((issue) => issue.ruleId),
    ).toContain('abyss/known-variable');
  });
  it('keeps a category identity across ordering and single-category scopes', () => {
    const a = { key: 'A', tone: 'accent' as const },
      b = { key: 'B', tone: 'accent' as const };
    expect(statisticsSeriesPaint(a, [a, b])).toBe(statisticsSeriesPaint(a, [b, a]));
    expect(statisticsSeriesPaint(a, [a, b])).toBe(statisticsSeriesPaint(a, [a]));
  });
  it('accepts finite host-derived series paints and rejects a fabricated token', () => {
    const peers = Array.from({ length: 13 }, (_, i) => ({
      key: `category:${i}`,
      tone: 'accent' as const,
    }));
    const paints = peers.map((peer) => statisticsSeriesPaint(peer, peers));
    expect(new Set(paints).size).toBe(13);
    for (const paint of paints)
      expect(analyze(`.abyss-statistics-swatch { color: ${paint}; }`)).toEqual([]);
    expect(
      analyze('.abyss-statistics-swatch { color: var(--statistics-fabricated); }').map(
        (issue) => issue.ruleId,
      ),
    ).toContain('abyss/known-variable');
    expect(statisticsSeriesPaint({ key: 'ordinary', tone: 'created' }, peers)).toBe(
      statisticsSeriesPaint({ key: 'recurring', tone: 'created', muted: true }, peers),
    );
    expect(
      statisticsSeriesOpacity({ key: 'recurring', tone: 'created', muted: true }),
    ).toBeLessThan(statisticsSeriesOpacity({ key: 'ordinary', tone: 'created' }));
  });
  it('never formats a measured tiny interval or fractional mean as zero', () => {
    expect(statisticsNumber(0.00025)).toBe('0.00025');
    expect(statisticsNumber(0)).toBe('0');
  });
});

it('backs the finite virtual row height contract with its native producer and scoped CSS consumer', async () => {
  const { default: ts } = await import('typescript');
  const source = ts.sys.readFile(ts.sys.resolvePath('src/panels/task-list/TaskListSurface.ts'));
  if (source === undefined) throw new Error('Missing task list surface owner');
  const runtime = discoverRuntimeVariables(source);
  expect(runtime.produced).toContain('--abyss-virtual-row-height');
  expect(contracts.runtime.produced).toContain('--abyss-virtual-row-height');
  const { loadPluginStyles, cssDeclarationsFor } = await import('./helpers');
  const css = await loadPluginStyles();
  const spacer = cssDeclarationsFor(css, '.abyss-task-list-surface > .abyss-virtual-row-spacer');
  expect(spacer).toContain('height: var(--abyss-virtual-row-height)');
  expect(cssDeclarationsFor(css, '.abyss-task-list-surface')).toContain('overflow-anchor: none');
  expect(
    analyzeCss(`.abyss-task-list-surface > .abyss-virtual-row-spacer { ${spacer} }`, {
      file: 'fixture.css',
      contracts: { ...fixtureContracts, runtime },
    }),
  ).toEqual([]);
});

it('backs Kanban column and hover spacing with a finite native spacer variable', async () => {
  const { default: ts } = await import('typescript');
  const source = ts.sys.readFile(
    ts.sys.resolvePath('src/panels/projects/projectKanbanViewport.ts'),
  );
  if (source === undefined) throw new Error('Missing Kanban native owner');
  const runtime = discoverRuntimeVariables(source);
  expect(runtime.produced).toContain('--abyss-project-kanban-spacer-height');
  expect(contracts.runtime.produced).toContain('--abyss-project-kanban-spacer-height');
  const { loadPluginStyles, cssDeclarationsFor } = await import('./helpers');
  const spacer = cssDeclarationsFor(
    await loadPluginStyles(),
    '.abyss-project-kanban-viewport-spacer',
  );
  expect(
    analyzeCss(`.abyss-project-kanban-viewport-spacer { ${spacer} }`, {
      file: 'fixture.css',
      contracts: { ...fixtureContracts, runtime },
    }),
  ).toEqual([]);
});

it('backs Timeline sparse spacing with the native owner variable', async () => {
  const { default: ts } = await import('typescript');
  const source = ts.sys.readFile(ts.sys.resolvePath('src/panels/projects/projectTimelineRows.ts'));
  if (source === undefined) throw new Error('Missing Timeline native owner');
  const runtime = discoverRuntimeVariables(source);
  expect(runtime.produced).toContain('--abyss-project-timeline-spacer-height');
  expect(contracts.runtime.produced).toContain('--abyss-project-timeline-spacer-height');
  const { loadPluginStyles, cssDeclarationsFor } = await import('./helpers');
  const spacer = cssDeclarationsFor(
    await loadPluginStyles(),
    '.abyss-project-timeline-viewport-spacer',
  );
  expect(spacer).toContain('height: var(--abyss-project-timeline-spacer-height)');
  expect(
    analyzeCss(`.abyss-project-timeline-viewport-spacer { ${spacer} }`, {
      file: 'fixture.css',
      contracts: {
        ...fixtureContracts,
        runtime: {
          ...runtime,
          produced: [
            ...runtime.produced,
            '--abyss-project-timeline-summary-width',
            '--abyss-project-timeline-track-width',
          ],
        },
      },
    }),
  ).toEqual([]);
});

it('reserves dependency picker geometry while preserving constrained flex shrink', async () => {
  const { loadPluginStyles, cssDeclarationsFor } = await import('./helpers');
  const css = await loadPluginStyles();
  expect(
    cssDeclarationsFor(css, '.abyss-dep-search .abyss-dep-search-results.has-candidates'),
  ).toContain('height: min(40vh, 16rem)');
  const list = cssDeclarationsFor(css, '.abyss-dep-search-results');
  expect(list).toContain('flex-shrink: 1');
  expect(list).toContain('min-height: 0');
  expect(list).toContain('max-height: min(40vh, 16rem)');
});

it('admits only the enrolled parked-row width producer and its scoped consumer', async () => {
  const { default: ts } = await import('typescript');
  const source = ts.sys.readFile(ts.sys.resolvePath('src/panels/task-list/TaskListSurface.ts'));
  if (source === undefined) throw new Error('Missing task list surface owner');
  const runtime = discoverRuntimeVariables(source);
  expect(runtime.produced).toContain('--abyss-virtual-row-width');
  expect(runtime.produced).toContain('--abyss-virtual-row-offset');
  expect(contracts.runtime.produced).toContain('--abyss-virtual-row-offset');
  expect(contracts.runtime.produced).toContain('--abyss-virtual-row-width');
  const { loadPluginStyles, cssDeclarationsFor } = await import('./helpers');
  const parked = cssDeclarationsFor(
    await loadPluginStyles(),
    '.abyss-task-list-surface > .abyss-virtual-row-frame > .abyss-virtual-row-parked',
  );
  expect(parked).toContain('width: var(--abyss-virtual-row-width)');
  expect(parked).toContain('bottom: 100%');
  expect(parked).toContain('top: auto');
  expect(parked).toContain('opacity: 0');
  expect(parked).toContain('pointer-events: none');
  expect(parked).not.toContain('transform:');
  const frame = cssDeclarationsFor(
    await loadPluginStyles(),
    '.abyss-task-list-surface > .abyss-virtual-row-frame',
  );
  expect(frame).toContain('position: static');
  expect(frame).toContain('height: auto');
  expect(frame).toContain('padding: 0');
  expect(frame).toContain('border: 0');
  const clipped = cssDeclarationsFor(
    await loadPluginStyles(),
    '.abyss-task-list-surface > .abyss-virtual-row-frame-clipped',
  );
  expect(clipped).toContain('overflow: clip');
  expect(clipped).toContain('height: var(--abyss-virtual-row-height)');
  const placed = cssDeclarationsFor(
    await loadPluginStyles(),
    '.abyss-task-list-surface > .abyss-virtual-row-frame-clipped > :not(.abyss-virtual-row-parked)',
  );
  expect(placed).toContain('top: var(--abyss-virtual-row-offset)');
  expect(
    analyzeCss(
      `.abyss-task-list-surface > .abyss-virtual-row-frame-clipped > :not(.abyss-virtual-row-parked) { ${placed} }`,
      { file: 'fixture.css', contracts: { ...fixtureContracts, runtime } },
    ),
  ).toEqual([]);
  expect(
    analyzeCss('.abyss-task-list-surface { top: var(--abyss-unowned-row-offset); }', {
      file: 'fixture.css',
      contracts: { ...fixtureContracts, runtime },
    }),
  ).not.toEqual([]);
  expect(
    analyzeCss(
      `.abyss-task-list-surface > .abyss-virtual-row-frame > .abyss-virtual-row-parked { ${parked} }`,
      {
        file: 'fixture.css',
        contracts: { ...fixtureContracts, runtime },
      },
    ),
  ).toEqual([]);
  expect(
    analyzeCss('.abyss-task-list-surface { width: var(--abyss-unowned-row-width); }', {
      file: 'fixture.css',
      contracts: { ...fixtureContracts, runtime },
    }),
  ).not.toEqual([]);
});

it('backs bounded Statistics ranking geometry with exact native height and offset variables', async () => {
  const ts = await import('typescript');
  const source = ts.sys.readFile(ts.sys.resolvePath('src/panels/statistics/StatisticsRowChart.ts'));
  if (source === undefined) throw new Error('Missing Statistics row chart');
  const runtime = discoverRuntimeVariables(source);
  expect(runtime.produced).toEqual([
    '--abyss-statistics-row-height',
    '--abyss-statistics-row-offset',
  ]);
  for (const variable of runtime.produced) expect(contracts.runtime.produced).toContain(variable);
  const { loadPluginStyles, cssDeclarationsFor } = await import('./helpers');
  const css = await loadPluginStyles();
  const canvas = cssDeclarationsFor(css, '.abyss-statistics-row-canvas'),
    content = cssDeclarationsFor(css, '.abyss-statistics-row-content');
  expect(canvas).toContain('block-size: var(--abyss-statistics-row-height)');
  expect(content).toContain('inset-block-start: var(--abyss-statistics-row-offset)');
  expect(
    analyzeCss(
      `.abyss-statistics-row-canvas { ${canvas} } .abyss-statistics-row-content { ${content} }`,
      { file: 'fixture.css', contracts: { ...fixtureContracts, runtime } },
    ),
  ).toEqual([]);
});
