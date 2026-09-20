import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import stylelint from 'stylelint';
import { correctnessPlugins, correctnessRules } from '../stylelint.config.mjs';
import { contracts, runtimeFamilies } from './css-contracts.mjs';
import { analyzeCss, discoverRuntimeVariables } from './css-policy.mjs';

const repository = path.resolve(import.meta.dirname, '..');
const artifact = process.argv.includes('--artifact');
const file = process.argv.slice(2).find((argument) => argument !== '--artifact');
if (!file) throw new Error('Usage: node tooling/check-css.mjs [--artifact] <stylesheet>');
const runtime = {
  produced: [...contracts.runtime.produced],
  consumed: [...contracts.runtime.consumed],
};
for (const entry of readdirSync(path.join(repository, 'src'), {
  recursive: true,
  withFileTypes: true,
})) {
  if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
  const sourceFile = path.join(entry.parentPath, entry.name);
  const relative = path.relative(repository, sourceFile);
  const found = discoverRuntimeVariables(
    readFileSync(sourceFile, 'utf8'),
    runtimeFamilies.filter((family) => family.file === relative),
  );
  runtime.produced.push(...found.produced);
  runtime.consumed.push(...found.consumed);
}
// Exception inventories are whole-stylesheet contracts. Arbitrary fixture inputs have none.
const shipped = artifact || path.resolve(file) === path.join(repository, 'styles.css');
const active = { ...contracts, runtime, exceptions: shipped ? contracts.exceptions : [] };
const css = readFileSync(file, 'utf8');
const diagnostics = analyzeCss(css, { file, contracts: active });
if (artifact) {
  const result = await stylelint.lint({
    code: css,
    codeFilename: path.resolve(file),
    config: { plugins: correctnessPlugins, rules: correctnessRules },
  });
  for (const warning of result.results.flatMap((result) => result.warnings)) {
    diagnostics.push({
      ruleId: warning.rule,
      file,
      line: warning.line,
      column: warning.column,
      message: warning.text,
    });
  }
}
for (const diagnostic of diagnostics) {
  process.stderr.write(
    `${diagnostic.file}:${diagnostic.line}:${diagnostic.column} ${diagnostic.ruleId} ${diagnostic.message}\n`,
  );
}
if (diagnostics.length > 0) process.exitCode = 1;
