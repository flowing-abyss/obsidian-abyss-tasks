import cssnano from 'cssnano';
import { transform } from 'esbuild';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import postcss from 'postcss';

const root = process.cwd();
rmSync(path.join(root, 'dist'), { recursive: true, force: true });
const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const budget = packageJson.release?.stylesCssBudgetBytes;
if (!Number.isSafeInteger(budget) || budget <= 0) {
  throw new Error('release.stylesCssBudgetBytes must be a positive safe integer');
}
const source = readFileSync(path.join(root, 'styles.css'), 'utf8');
const { code: compactCss, warnings } = await transform(source, { loader: 'css', minify: true });
if (warnings.length > 0) {
  throw new Error(`styles.css produced ${warnings.length} esbuild warning(s)`);
}
let optimized;
try {
  optimized = await postcss([
    cssnano({ preset: ['default', { minifySelectors: false, svgo: false }] }),
  ]).process(compactCss, { from: undefined });
} catch (cause) {
  throw new Error('Could not optimize styles.css for release', { cause });
}
if (optimized.warnings().length > 0) {
  throw new Error(`styles.css produced ${optimized.warnings().length} cssnano warning(s)`);
}
const code = `${optimized.css.trim()}\n`;
if (code.trim().length === 0) {
  throw new Error('styles.css produced empty release CSS');
}
const bytes = Buffer.byteLength(code);
if (bytes > budget) {
  throw new Error(`styles.css is ${bytes} bytes, over the ${budget}-byte budget`);
}
mkdirSync(path.join(root, 'dist'));
writeFileSync(path.join(root, 'dist/styles.css'), code);
