import { transform } from 'esbuild';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
rmSync(path.join(root, 'dist'), { recursive: true, force: true });
const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const budget = packageJson.release?.stylesCssBudgetBytes;
if (!Number.isSafeInteger(budget) || budget <= 0) {
  throw new Error('release.stylesCssBudgetBytes must be a positive safe integer');
}
const source = readFileSync(path.join(root, 'styles.css'), 'utf8');
const { code, warnings } = await transform(source, { loader: 'css', minify: true });
if (warnings.length > 0) {
  throw new Error(`styles.css produced ${warnings.length} esbuild warning(s)`);
}
if (code.trim().length === 0) {
  throw new Error('styles.css produced empty release CSS');
}
const bytes = Buffer.byteLength(code);
if (bytes > budget) {
  throw new Error(`styles.css is ${bytes} bytes, over the ${budget}-byte budget`);
}
mkdirSync(path.join(root, 'dist'));
writeFileSync(path.join(root, 'dist/styles.css'), code);
