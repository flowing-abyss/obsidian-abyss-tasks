import { describe, expect, it } from 'vitest';
import { MeasuredWindow } from '../src/panels/projects/BoundedWindow';
import { PROJECTS_SCALE_FIXTURE, assertProjectsScaleFixture } from './fixtures/projects-scale';

describe('Projects frozen scale fixture', () => {
  it('self-validates its immutable exact distribution', () => {
    expect(() => assertProjectsScaleFixture()).not.toThrow();
    expect(PROJECTS_SCALE_FIXTURE.projects).toHaveLength(5);
    expect(PROJECTS_SCALE_FIXTURE.workNotes).toHaveLength(250);
    expect(PROJECTS_SCALE_FIXTURE.tasks).toHaveLength(1_000);
    expect(PROJECTS_SCALE_FIXTURE.milestones).toHaveLength(25);
    expect(Object.isFrozen(PROJECTS_SCALE_FIXTURE.deltas.storm)).toBe(true);
  });
});

describe('MeasuredWindow', () => {
  const keys = PROJECTS_SCALE_FIXTURE.expectedTaskKeys;

  it('mounts only a bounded viewport slice while preserving variable extents', () => {
    const window = new MeasuredWindow(keys, { estimateExtent: 56, overscan: 8 });
    for (let index = 0; index < 80; index += 1) {
      window.measure(keys[index]!, index % 3 === 0 ? 96 : index % 3 === 1 ? 44 : 68);
    }

    const range = window.range({ scrollTop: 1_640, viewportExtent: 720 });

    expect(range.end - range.start).toBeLessThanOrEqual(60);
    expect(range.startSpacer).toBe(
      keys.slice(0, range.start).reduce((sum, key) => sum + window.extentOf(key), 0),
    );
    expect(range.endSpacer).toBe(
      keys.slice(range.end).reduce((sum, key) => sum + window.extentOf(key), 0),
    );
    expect(range.firstVisible).toBeGreaterThan(0);
  });

  it('seeds non-zero virtual extent before restoring a deep first mount', () => {
    const window = new MeasuredWindow(keys, { estimateExtent: 56, overscan: 8 });
    const seeded = window.seed({ firstKey: keys[640]!, firstIndex: 640, viewportExtent: 720 });

    expect(seeded.scrollTop).toBeGreaterThan(0);
    expect(seeded.totalExtent).toBeGreaterThan(seeded.scrollTop + 720);
    expect(seeded.range.start).toBeGreaterThan(0);
    expect(seeded.range.end - seeded.range.start).toBeLessThanOrEqual(60);
  });

  it('keeps the first and last partially visible variable rows inside the window', () => {
    const shortKeys = keys.slice(0, 8);
    const window = new MeasuredWindow(shortKeys, { estimateExtent: 50, overscan: 0 });
    window.measure(shortKeys[0]!, 30);
    window.measure(shortKeys[1]!, 90);
    window.measure(shortKeys[2]!, 40);

    const range = window.range({ scrollTop: 29, viewportExtent: 92 });
    expect(shortKeys.slice(range.start, range.end)).toEqual(shortKeys.slice(0, 3));
  });
});
