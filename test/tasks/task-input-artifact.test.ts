// @vitest-environment node
import { build } from 'esbuild';
import { Platform } from 'obsidian';
import { describe, expect, it } from 'vitest';
import type { TaskInputRecognizer } from '../../src/tasks/application/TaskInputRecognizer';
import { localDate, localTime } from '../../src/tasks/domain/validation';
import { CHILD_PROCESS_TIMEOUT_MS } from '../support/timeouts';
const ROOT = new URL('../..', import.meta.url).pathname;
const loadRuntime = async () => {
  if (!Platform.isDesktop) throw new Error('Artifact inspection requires desktop runtime');
  return import('node:vm');
};
const { compileFunction } = await loadRuntime();
describe('offline Chrono locale artifact', () => {
  it(
    'bundles only en/ru and executes without external runtime or lookbehind',
    async () => {
      const artifact = await build({
        absWorkingDir: ROOT,
        entryPoints: ['src/tasks/infrastructure/input/ChronoTaskInputRecognizer.ts'],
        bundle: true,
        write: false,
        format: 'iife',
        globalName: 'TaskInputArtifact',
        platform: 'browser',
        target: 'es2021',
        metafile: true,
      });
      const source = artifact.outputFiles[0]?.text;
      expect(source).toBeDefined();
      if (source === undefined) throw new Error('Missing input adapter artifact');
      const locales = Object.keys(artifact.metafile.inputs)
        .filter((path) => path.includes('/locales/'))
        .map((path) => path.split('/locales/')[1]?.split('/')[0]);
      expect([...new Set(locales)].sort((a, b) => (a ?? '').localeCompare(b ?? ''))).toEqual([
        'en',
        'ru',
      ]);
      expect(source).not.toContain('(?<' + '=');
      expect(source).not.toContain('(?<' + '!');
      expect(Object.values(artifact.metafile.outputs).flatMap((output) => output.imports)).toEqual(
        [],
      );
      const execute = compileFunction(
        `${source}; return new TaskInputArtifact.ChronoTaskInputRecognizer();`,
        [],
      ) as () => TaskInputRecognizer;
      const result = execute().recognize({
        text: 'Call tomorrow at 14:00',
        reference: {
          epochMs: 1791867600000,
          localDate: localDate('2026-10-13'),
          localTime: localTime('12:00'),
          second: 0,
          offsetMinutes: 420,
        },
        protectedRanges: [],
      });
      expect(result).toEqual([
        {
          kind: 'date-time',
          status: 'point',
          ranges: [
            { from: 5, to: 13 },
            { from: 14, to: 22 },
          ],
          dateRanges: [{ from: 5, to: 13 }],
          timeRanges: [{ from: 14, to: 22 }],
          date: '2026-10-14',
          time: '14:00',
          dateOrigin: 'relative',
          yearExplicit: false,
        },
      ]);
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );
});
