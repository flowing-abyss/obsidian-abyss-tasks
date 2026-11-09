// Exact note ranges, owned search yields and physical-root lookups: licensed main 3,980,577 bytes.
// No dependencies added; approved minimum main budget 3,981,312 bytes (3888 KiB), below 5,000,000.
// Enforced project-move focus through admission and exact comment-helper aliases: measured main 3,978,134 bytes.
// No dependencies added; approved minimum main budget 3,978,240 bytes (3885 KiB), below 5,000,000.
// Turn-local typed references, bounded repair/read continuation and native hierarchy review: measured main 3,976,377 bytes.
// No dependencies added; approved minimal containing main budget 3,977,216 bytes (3884 KiB), below 5,000,000.
// CommandMode diagnostic, paging, current-reference and billing fixes: measured licensed main 3,969,786 bytes.
// No dependencies added; approved minimal containing main budget 3,970,048 bytes (3877 KiB), below 5,000,000.
// Native hierarchy/project proposals and exact CommandMode references: measured licensed main 3,968,793 bytes.
// No dependencies added; approved minimal containing main budget 3,969,024 bytes (3876 KiB), below 5,000,000.
// Native CommandMode voice and shared input ownership: measured licensed main 3,938,348 bytes.
// Controller-approved minimum main cap 3,939,328 bytes (3847 KiB); CSS stays 224,256 bytes, strict main ceiling below 5,000,000.
// CommandMode note review readiness and verified readback: measured licensed main 3,919,454 bytes.
// Controller-approved minimum caps: main 3,919,872 bytes (3828 KiB), compact note CSS 224,256 bytes (219 KiB; measured 223,384).
// No new dependencies; strict final raw main ceiling below 5,000,000 remains enforced.
// Native Q command tree and retained proposal corrections: measured licensed main 3,891,356 bytes.
// Controller-approved containing limit 3,892,224 bytes (3801 KiB); strict final ceiling remains below 5,000,000.
// Semantic command core with the real SDK runtime and native continuity/link formatting: 3,544,410 -> 3,793,056 bytes.
// Licensed artifact fits the measured 3,807,232-byte (3718 KiB) cap; the hard 5,000,000-byte ceiling remains.
// Prepared initial status, source-copy witnesses and merge inventory: 3,520,640 -> 3,544,410 bytes (+23,770).
// No new dependencies; measured licensed artifact uses the minimal 3,545,088-byte (3462 KiB) cap, below 5,000,000 bytes.
// Explicit provider factories and native SecretStorage: 2,478,468 -> 3,520,640 bytes, including installed notices.
// Minimal containing budget 3,521,536 bytes (3439 KiB), below 5,000,000 bytes.
// Guarded note search, sections and static creation: 2,438,428 -> 2,478,468 bytes (+40,040).
// No new dependencies; minimal containing budget 2,479,104 bytes (2421 KiB), below 5,000,000 bytes.
// Original acquisition proof through capture/read continuations: 2,438,242 -> 2,438,428 bytes (+186).
// No new dependencies; existing 2,439,168-byte (2382 KiB) main budget remains enforced.
// Native preparation acquisition and exact-source echo continuity: 2,436,578 -> 2,438,242 bytes (+1,664).
// No new dependencies; minimal containing main budget: 2,439,168 bytes (2382 KiB), below the 5,000,000-byte ceiling.
// Content delivery disclosure and provisional-plan cleanup: 2,434,812 -> 2,436,578 bytes (+1,766).
// No new dependencies; minimal containing main budget: 2,437,120 bytes (2380 KiB), below the 5,000,000-byte ceiling.
// Public task content/tree/search facade and insertion continuity: 2,397,444 -> 2,434,812 bytes (+37,368).
// No new dependencies; minimal containing main budget: 2,435,072 bytes (2378 KiB), below the 5,000,000-byte ceiling.
// Sealed-plan refresh: baseline 2,386,453 → 2,397,444 bytes (+10,991).
// No new dependencies; minimal containing main budget: 2,398,208 bytes (2342 KiB).
// Sealed full-tree creation and guarded static provisioning: 2,372,956 -> 2,386,366 bytes.
// No new dependencies; minimal containing main budget: 2,386,944 bytes (2331 KiB).
// Canonical prepared tree edits and composed occurrence witnesses: 2,367,374 -> 2,372,956 bytes.
// No new bundled dependencies; use the minimal containing 2,373,632-byte main limit.
// Shared project mutation lifetime and defensive receipts: measured main 2,248,667 bytes (+990).
// Deliberately increase the main cap by 1 KiB to 2,248,704; retain hard enforcement and CSS limits.
// Dependency inventory is unchanged.
// Compact date editors and hidden list recovery: measured main 2,240,169 bytes; containing limit 2188 KiB.
// Project boundary handles: measured main 2,215,176 bytes; containing limit 2164 KiB.
// Axis and passive boundary styles: shipped CSS 205,867 bytes; containing limit 202 KiB.
// Dashboard receipt continuity and Undo/Redo: measured main 2,213,176 bytes; 2162 KiB limit.
// Project context row: shipped CSS 204,141 bytes; containing limit 200 KiB.
// Shared project range adapter and endpoint guards: main 2,212,289 bytes; 2161 KiB limit.
// Compact project toolbar and Kanban capture: shipped CSS 203,451 bytes; 199 KiB limit.
// Task view refinements: measured main 2,206,787 bytes; containing limit 2156 KiB.
// Guarded context/rename transitions and deferred inspector geometry: main 2,204,758 bytes.
// Minimal containing main limit: 2154 KiB; shipped CSS remains 201,590 bytes / 197 KiB.
// Shared dashboard task inspector: measured main 2,204,274 bytes, CSS 201,590 bytes.
// Minimal containing main limit: 2153 KiB; the 197 KiB CSS limit is unchanged.
// Tasks Timeline adds shared calendar gestures, virtual rows and date controls: measured
// main 2,202,637 bytes, CSS 201,014 bytes. Minimal containing limits: 2152 / 197 KiB.
// Independent Kanban scroll receipts: main 2181762 bytes; 2182144-byte limit.
// Narrow task toolbar adds 579 shipped CSS bytes (199,705 total); 196 KiB contains it.
// Kanban shared grouping and guarded single/bulk drops: measured main 2180929 bytes;
// minimal containing KiB budget 2181120 bytes. No new dependencies.
import esbuild from 'esbuild';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'process';

// Tasks Kanban reuses task viewports/cards and adds guarded status capture/drop adapters.
// Measured main: 2,152,652 -> 2,177,160 bytes (+24,508); shipped CSS: 197,384 ->
// 199,126 bytes (+1,742). Use the minimal containing KiB budgets; no dependencies added.
// Shared with release-check.mjs, which re-checks the same threshold against an
// already-built main.js — both read this key so the two checks can't drift apart.
// Obsidian loads every enabled plugin's `main.js` at vault startup — a size
// regression is a user-facing cost, not just a build metric. Bump this in
// package.json if the plugin legitimately grows, but bump it deliberately.
// Analysis Movement endpoints, project coverage/focus and Aging density received a measured
// 5 KiB total main increase including compact origin-band geometry.
// Task 7's eligible/scoped/bounded dependency correction adds 3,525 measured bytes;
// allow its approved 4 KiB increase. The final twelve Analysis clarity corrections add
// 2,894 measured bytes; allow the approved further 3 KiB (1853 KiB main / unchanged 181 KiB CSS).
// Smart Q: baseline 1,898,487 bytes; final 2,016,864 (+118,377 bytes).
// Chrono 2.10.3 en/ru contributes 71,101 production bytes (71,201 locale-only);
// the remaining 47,276 bytes cover smart capture and the added MIT notice.
// The measured final limit is ceil(2,016,864 / 1024) * 1024 = 2,017,280 (1970 KiB).
// Shipped CSS is 185,777 bytes (+1,045), within its unchanged 185,856-byte limit.
// Q caption transfer: Task 1 baseline 2,016,990 bytes; final 2,018,100 (+1,110 bytes).
// Its minimal containing main limit is 2,018,304 bytes (1971 KiB); CSS is unchanged.
// Q semantic metadata colors: accepted baseline 2,018,100 bytes; final 2,018,557 (+457 bytes).
// Its minimal containing main limit is 2,019,328 bytes (1972 KiB); CSS is unchanged.
// Q retained canonical context: measured 2,024,012 bytes; the approved next-KiB main limit is
// 2,024,448 bytes (1977 KiB). The CSS limit is unchanged.
// Q calendar-day capture: baseline 2,051,744 bytes; measured 2,052,158 bytes (+414 bytes).
// The next-KiB main limit is 2,053,120 bytes (2005 KiB). The CSS limit is unchanged.
// Indexed subtree node search: baseline 2,054,781 bytes; measured 2,058,283 (+3,502 bytes).
// Shared inline/Worker aggregation and scope validation use the next-KiB main limit of
// 2,059,264 bytes (2011 KiB). CSS and dependency scope are unchanged.
// Filter exact subtree context and guarded in-place activation: baseline 2,058,283 bytes;
// measured 2,059,457 (+1,174 bytes), including retained base description previews.
// The minimal next-KiB main limit is 2,060,288 bytes (2012 KiB); CSS and dependencies are unchanged.
// Dependency scope and budget enforcement are unchanged.
// Compact calendar: main 2,108,351 -> 2,116,217 bytes (+7,866); shipped CSS
// 189,482 -> 192,748 bytes (+3,266), after consolidating superseded phone toolbar rules.
// Approved next-KiB limits are 2,116,608 (2067 KiB) and 193,536 (189 KiB).
// No dependencies were added; both artifact checks retain size enforcement.
// Native inspector lifetime, date-based week links and mobile Day activation:
// main 2,116,217 -> 2,117,294 bytes (+1,077). Approved next-KiB limit: 2,117,632 (2068 KiB).
// CSS enforcement and dependency scope are unchanged.
// Prepared index observations and compiled source policy: main 2,118,553 -> 2,118,969 bytes
// (+416). Approved next-KiB limit: 2,119,680 (2070 KiB); CSS and dependencies are unchanged.
// Configured-week titles and retained calendar pointer intent: main 2,119,033 -> 2,120,099
// bytes (+1,066). Approved next-KiB limit: 2,120,704 (2071 KiB); CSS remains 193,508 bytes
// within its unchanged 193,536-byte cap. Artifact enforcement and dependencies are unchanged.
// Canonical calendar agenda/capture reuse and navigation correction: main 2,120,186 ->
// 2,121,841 bytes (+1,655, including 43 bytes for the action group). No dependencies added.
// The minimal containing next-KiB main limit is 2,122,752 bytes (2073 KiB); shipped CSS
// is 190,883 bytes within its unchanged 193,536-byte cap. All artifact enforcement remains.
// Source-independent forecast templates: main 2,122,720 -> 2,122,784 bytes (+64).
// Approved next-KiB main limit: 2,123,776 bytes (2074 KiB). Shipped CSS is 190,904 bytes
// within its unchanged 193,536-byte cap; dependency scope and artifact enforcement are unchanged.
// Inspector edit slots and retained calendar/list interactions: main 2,124,496 ->
// 2,135,375 bytes (+10,879); shipped CSS 194,520 -> 195,043 bytes (+523).
// Includes exact successor submission after inspector saves and scrollport containment.
// Minimal containing KiB limits: 2,136,064 (2086 KiB) and 195,584 (191 KiB).
// Bundled dependency modules are unchanged; both artifact size checks remain enforced.
// Current-time label and interrupted card tracks: main 2,135,563 -> 2,136,212 bytes (+649),
// shipped CSS 195,331 -> 196,857 bytes (+1,526). No dependencies added. Minimal containing
// KiB limits are 2,137,088 (2087 KiB) and 197,632 (193 KiB); both checks remain enforced.
// Calendar pointer publication, serialized editing and focus retention: main 2,145,556 bytes.
// No dependencies added; the minimal containing main limit is 2,146,304 bytes (2096 KiB).
// CSS remains within 197,632 bytes. Both artifact checks remain enforced.
// Mobile inspector visibility and keyboard-bounded link suggestions: main 2,150,070 ->
// 2,152,652 bytes (+2,582); no dependencies added. The minimal containing KiB limit is
// 2,153,472 bytes (2103 KiB). CSS and artifact enforcement remain unchanged.
// Retained dashboard editors, timeline release ownership, and measured shell inset: main 2,224,581
// bytes, no new dependencies. The minimal containing KiB limit is 2,225,152 (2173 KiB).
// CSS remains within its existing limit; both artifact checks stay enforced.
// Retained exact-source rows and the phone project toolbar use the minimal containing
// limits 2176 / 204 KiB. No dependencies added; artifact checks remain enforced.
// Retained dashboard property cells and status lifecycle guards: 2,234,303 bytes, contained by
// 2182 KiB. Compact controls/shared cell CSS remains within 205 KiB.
// Uses existing renderers and dependencies; enforcement remains unchanged.
// Dashboard spacing and explicit footer visibility add 570 main bytes (2,234,303 -> 2,234,873)
// and 292 CSS bytes (209,912 -> 210,204). Minimal containing limits: 2183 / 206 KiB.
// No dependencies added; both artifact checks remain enforced.
// Status-aware temporal lists and column-scoped selection: 2,234,873 -> 2,235,886 bytes (+1013).
// The minimal containing main limit is 2184 KiB; CSS stays within 206 KiB. No dependencies added.
// Scroll/admission guards and queued view-state rebasing: 2,237,982 -> 2,238,659 bytes (+677).
// The minimal containing main limit is 2187 KiB; CSS and dependencies are unchanged.
const { mainJsBudgetBytes: MAIN_JS_BUDGET_BYTES } = JSON.parse(
  readFileSync('package.json', 'utf8'),
).release;
const chartsEntry = fileURLToPath(import.meta.resolve('@tanstack/charts'));
const chartsRequire = createRequire(chartsEntry);
const arrayRequire = createRequire(chartsRequire.resolve('d3-array'));
const sdkRequire = createRequire(fileURLToPath(import.meta.resolve('@ai-sdk/openai')));
const providerUtilsEntry = sdkRequire.resolve('@ai-sdk/provider-utils');
const providerUtilsRequire = createRequire(providerUtilsEntry);
const thirdPartyNotices = [
  dependencyNotice('@tanstack/charts', chartsEntry, 'LICENSE'),
  dependencyNotice('d3-array', chartsRequire.resolve('d3-array'), 'LICENSE'),
  dependencyNotice('d3-scale', chartsRequire.resolve('d3-scale'), 'LICENSE'),
  dependencyNotice('d3-shape', chartsRequire.resolve('d3-shape'), 'LICENSE'),
  dependencyNotice('internmap', arrayRequire.resolve('internmap'), 'LICENSE'),
  dependencyNotice('minisearch', fileURLToPath(import.meta.resolve('minisearch')), 'LICENSE.txt'),
  dependencyNotice(
    'chrono-node',
    fileURLToPath(import.meta.resolve('chrono-node/ru')),
    'LICENSE.txt',
  ),
  dependencyNotice('rrule', fileURLToPath(import.meta.resolve('rrule')), 'LICENCE'),
  dependencyNotice(
    '@ai-sdk/openai',
    fileURLToPath(import.meta.resolve('@ai-sdk/openai')),
    'LICENSE',
  ),
  dependencyNotice(
    '@ai-sdk/anthropic',
    fileURLToPath(import.meta.resolve('@ai-sdk/anthropic')),
    'LICENSE',
  ),
  dependencyNotice(
    '@openrouter/ai-sdk-provider',
    fileURLToPath(import.meta.resolve('@openrouter/ai-sdk-provider')),
    'LICENSE',
  ),
  dependencyNotice('zod', fileURLToPath(import.meta.resolve('zod')), 'LICENSE'),
  dependencyNotice('@ai-sdk/provider', sdkRequire.resolve('@ai-sdk/provider'), 'LICENSE'),
  providerUtilsNotice(),
  dependencyNotice(
    'eventsource-parser',
    providerUtilsRequire.resolve('eventsource-parser'),
    'LICENSE',
  ),
  dependencyNotice(
    '@workflow/serde',
    providerUtilsRequire.resolve('@workflow/serde'),
    'LICENSE.md',
  ),
].join('\n\n\n');
if (thirdPartyNotices.length === 0 || thirdPartyNotices.includes('*/')) {
  throw new Error('Third-party notices must be nonempty and safe to embed in a JavaScript comment');
}

const banner = `/*
THIS IS A GENERATED/BUNDLED FILE BY ESBUILD
if you want to view the source, please visit the github repository of this plugin
*/
/*
${thirdPartyNotices}
*/
`;

const args = process.argv.slice(2);
const prod = args.includes('production');
const analyze = args.includes('analyze');
const profile = args.includes('profile');

// Obsidian strips inline source maps from dev builds unless main.js ends with
// this exact marker comment: https://forum.obsidian.md/t/source-map-trimming-in-dev-builds/87612
const nosourcemapPlugin = {
  name: 'nosourcemap-marker',
  setup(build) {
    build.onEnd(() => {
      if (!prod) {
        appendFileSync('main.js', '\n/* nosourcemap */');
      }
    });
  },
};

/** @type {import('esbuild').Plugin} */
const taskSearchWorkerPlugin = {
  name: 'task-search-worker',
  setup(build) {
    build.onResolve({ filter: /^abyss-task-search-worker$/ }, () => ({
      path: 'abyss-task-search-worker',
      namespace: 'task-search-worker',
    }));
    build.onLoad({ filter: /.*/, namespace: 'task-search-worker' }, async () => {
      const worker = await esbuild.build({
        entryPoints: ['src/tasks/infrastructure/search/taskSearch.worker.ts'],
        bundle: true,
        platform: 'browser',
        format: 'iife',
        target: 'es2021',
        write: false,
        metafile: true,
        minify: prod,
        mangleProps: prod ? /_abyssPrivate$/ : undefined,
      });
      const source = '/* abyss-task-search-worker */' + worker.outputFiles[0].text;
      return {
        contents: 'export default ' + JSON.stringify(source),
        loader: 'js',
        watchFiles: Object.keys(worker.metafile.inputs).map((file) => path.resolve(file)),
      };
    });
  },
};

const context = await esbuild.context({
  banner: {
    js: banner,
  },
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: [
    'obsidian',
    'electron',
    '@codemirror/autocomplete',
    '@codemirror/collab',
    '@codemirror/commands',
    '@codemirror/language',
    '@codemirror/lint',
    '@codemirror/search',
    '@codemirror/state',
    '@codemirror/view',
    '@lezer/common',
    '@lezer/highlight',
    '@lezer/lr',
    ...builtinModules,
  ],
  format: 'cjs',
  target: 'es2021',
  logLevel: analyze ? 'silent' : 'info',
  sourcemap: prod ? (profile ? 'external' : false) : 'inline',
  drop: ['debugger'],
  treeShaking: true,
  outfile: 'main.js',
  minify: prod,
  // Opt in only audited TypeScript private members; public, Obsidian and persisted keys
  // never carry this suffix. Quoted/indirect property names must remain unmangled.
  mangleProps: prod ? /_abyssPrivate$/ : undefined,
  mangleQuoted: false,
  metafile: prod || analyze,
  plugins: [taskSearchWorkerPlugin, nosourcemapPlugin],
});

if (prod) {
  const result = await context.rebuild();
  if (analyze) {
    console.info(await esbuild.analyzeMetafile(result.metafile, { verbose: false }));
  }
  checkSizeBudget(result.metafile);
  process.exit(0);
} else {
  await context.watch();
}

function checkSizeBudget(metafile) {
  const bytes = Object.entries(metafile.outputs)
    .filter(([name]) => name.endsWith('.js'))
    .reduce((total, [, output]) => total + output.bytes, 0);

  if (bytes > MAIN_JS_BUDGET_BYTES) {
    console.error(
      `main.js is ${(bytes / 1024).toFixed(1)} KB, over the ${(MAIN_JS_BUDGET_BYTES / 1024).toFixed(0)} KB budget in esbuild.config.mjs. ` +
        'Check for an accidentally-bundled dependency, or raise the budget deliberately.',
    );
    process.exit(1);
  }
}

function dependencyNotice(name, entry, licenseFile) {
  const { directory, pkg } = installedPackage(name, entry);
  const license = readFileSync(path.join(directory, licenseFile), 'utf8').trim();
  if (license.length === 0) throw new Error(`The installed license for ${name} is empty`);
  const modification =
    name === '@openrouter/ai-sdk-provider'
      ? '\nModified by Abyss Tasks: legacy multiline regex flag expansion explicitly rejects unsupported lookbehind; see the pinned pnpm patch.'
      : '';
  return `Package: ${name}@${pkg.version}\nLicense: ${pkg.license}${modification}\n${'-'.repeat(72)}\n\n${license}`;
}

// provider-utils5.0.75 omits LICENSE from its package. Its official vercel/ai
// monorepo uses the identical Vercel Apache notice installed with ai7.0.164.
// Full Apache terms are included by OpenRouter's installed LICENSE above.
function providerUtilsNotice() {
  const { pkg } = installedPackage('@ai-sdk/provider-utils', providerUtilsEntry);
  const shared = installedPackage('ai', fileURLToPath(import.meta.resolve('ai')));
  if (
    pkg.version !== '5.0.75' ||
    shared.pkg.version !== '7.0.164' ||
    pkg.license !== 'Apache-2.0' ||
    shared.pkg.license !== 'Apache-2.0'
  )
    throw new Error(
      'Recheck the provider-utils shared license attribution after dependency changes.',
    );
  const notice = readFileSync(path.join(shared.directory, 'LICENSE'), 'utf8').trim();
  if (notice.length === 0) throw new Error('The shared AI SDK license notice is empty.');
  return `Package: @ai-sdk/provider-utils@${pkg.version}\nLicense: ${pkg.license}\nModified by Abyss Tasks: legacy multiline regex flag expansion explicitly rejects unsupported lookbehind; see the pinned pnpm patch.\nShared notice source: installed ai@${shared.pkg.version}/LICENSE; https://github.com/vercel/ai/blob/main/LICENSE\n${'-'.repeat(72)}\n\n${notice}`;
}

function installedPackage(name, entry) {
  let directory = path.dirname(entry);
  while (true) {
    const manifest = path.join(directory, 'package.json');
    if (existsSync(manifest)) {
      const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
      if (pkg.name === name) return { directory, pkg };
    }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error(`Cannot locate the installed package ${name}`);
    directory = parent;
  }
}
