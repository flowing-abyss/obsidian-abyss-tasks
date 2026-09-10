import { describe, expect, it } from 'vitest';
import {
  compatibleProjectPropertyPresets,
  compileProjectPropertyPresets,
  compiledProjectPropertyPresentation,
  projectPropertyPresetIssue,
} from '../src/projects/projectPropertyPresets';

describe('project property preset options', () => {
  it('keeps only enabled, valid presets compatible with the configured type', () => {
    expect(
      compatibleProjectPropertyPresets({
        type: 'number',
        presetsEnabled: true,
        presets: [
          { value: 42, displayName: 'Forty two' },
          { value: '42', displayName: 'Legacy text' },
          { value: Number.POSITIVE_INFINITY },
          null,
        ],
      }),
    ).toEqual([{ value: 42, displayName: 'Forty two' }]);
    expect(
      compatibleProjectPropertyPresets({
        type: 'number',
        presetsEnabled: false,
        presets: [{ value: 42 }],
      }),
    ).toEqual([]);
  });

  it('validates nonempty, finite, tag-shaped and exact typed identities', () => {
    expect(projectPropertyPresetIssue('text', { value: '' }, [])).toContain('empty');
    expect(projectPropertyPresetIssue('number', { value: Number.NaN }, [])).toContain('finite');
    expect(projectPropertyPresetIssue('tags', { value: 'two words' }, [])).toContain('tag');
    expect(projectPropertyPresetIssue('tags', { value: '123' }, [])).toContain('tag');
    expect(projectPropertyPresetIssue('tags', { value: 'a,b' }, [])).toContain('tag');
    expect(projectPropertyPresetIssue('tags', { value: 'a//b' }, [])).toContain('tag');
    expect(projectPropertyPresetIssue('tags', { value: 'work/project' }, [])).toBeUndefined();
    expect(projectPropertyPresetIssue('list', { value: 1 }, [{ value: '1' }])).toBeUndefined();
    expect(projectPropertyPresetIssue('list', { value: 1 }, [{ value: 1 }])).toContain('unique');
    expect(projectPropertyPresetIssue('date', { value: '2026-09-10' }, [])).toContain(
      'incompatible',
    );
  });

  it('treats malformed definitions as recoverable and compiles unique identities once', () => {
    expect(compatibleProjectPropertyPresets(null)).toEqual([]);
    const definition = {
      type: 'list' as const,
      presetsEnabled: true,
      presets: [
        { value: 'same', displayName: 'First' },
        { value: 'same', displayName: 'Duplicate' },
        { value: 7, displayName: 'Seven' },
      ],
    };

    const compiled = compileProjectPropertyPresets(definition);

    expect(compiled.presets).toEqual([{ value: 7, displayName: 'Seven' }]);
    expect(compiledProjectPropertyPresentation(compiled, 7)?.displayName).toBe('Seven');
    expect(compiledProjectPropertyPresentation(compiled, '7')).toBeUndefined();
  });

  it('compiles a large preset list with linear value inspection', () => {
    let reads = 0;
    const presets = Array.from({ length: 200 }, (_, index) =>
      Object.defineProperty({}, 'value', {
        enumerable: true,
        get: () => {
          reads++;
          return `value-${index}`;
        },
      }),
    );

    const compiled = compileProjectPropertyPresets({
      type: 'text',
      presetsEnabled: true,
      presets,
    });

    expect(compiled.presets).toHaveLength(200);
    expect(reads).toBeLessThan(2000);
  });
});
