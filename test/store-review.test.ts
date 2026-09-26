import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = ts.sys.resolvePath(`${import.meta.dirname}/..`);

function readRepositoryFile(path: string): string {
  const text = ts.sys.readFile(ts.sys.resolvePath(`${ROOT}/${path}`));
  if (text === undefined) throw new Error(`Expected ${path} to be readable`);
  return text;
}

interface PackageManifest {
  readonly name: string;
  readonly version: string;
  readonly dependencies?: Readonly<Record<string, string>>;
}

function readManifest(path: string): PackageManifest {
  return JSON.parse(readRepositoryFile(path)) as PackageManifest;
}

describe('README', () => {
  const readme = readRepositoryFile('README.md');

  it('is titled with the plugin name from the manifest', () => {
    expect(readme.split('\n')[0]).toBe(`# ${readManifest('manifest.json').name}`);
  });

  it('has an installation and a usage section', () => {
    const headings = readme.split('\n').filter((line) => line.startsWith('## '));

    expect(headings).toContain('## Installation');
    expect(headings).toContain('## Usage');
  });

  it('carries the licence of the bundled rrule package verbatim, with its version', () => {
    const { version } = readManifest('node_modules/rrule/package.json');

    expect(readme).toContain(readRepositoryFile('node_modules/rrule/LICENCE'));
    expect(readme).toContain(`[rrule](https://github.com/jkbrzt/rrule) ${version},`);
  });

  // Every runtime package is bundled into main.js, so a new one needs its own notice decision.
  it('bundles rrule as the only runtime package', () => {
    expect(Object.keys(readManifest('package.json').dependencies ?? {})).toEqual(['rrule']);
  });
});
