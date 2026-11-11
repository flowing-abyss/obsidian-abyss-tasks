// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { acceptsDevelopmentMinimum } from '../tooling/published-metadata.mjs';
const published = {
  package: { version: '2.3.2' },
  manifest: { id: 'abyss-tasks', version: '2.3.2', minAppVersion: '1.7.2' },
  versions: { '2.3.1': '1.7.2', '2.3.2': '1.7.2' },
};
const current = { ...published, manifest: { ...published.manifest, minAppVersion: '1.11.5' } };
const evidence = {
  published,
  tag: '2.3.2',
  localCommit: 'a'.repeat(40),
  remoteCommit: 'a'.repeat(40),
  reachable: true,
  release: { tag_name: '2.3.2', draft: false, prerelease: false, published_at: '2026-11-01' },
};
describe('published minimum compatibility', () => {
  it('accepts only an increased working minimum backed by unchanged published history', () => {
    expect(acceptsDevelopmentMinimum(current, evidence)).toBe(true);
    expect(acceptsDevelopmentMinimum(current, undefined)).toBe(false);
    expect(acceptsDevelopmentMinimum(current, { ...evidence, remoteCommit: 'b'.repeat(40) })).toBe(
      false,
    );
    expect(acceptsDevelopmentMinimum(current, { ...evidence, reachable: false })).toBe(false);
    expect(
      acceptsDevelopmentMinimum(current, {
        ...evidence,
        release: { ...evidence.release, draft: true },
      }),
    ).toBe(false);
    expect(
      acceptsDevelopmentMinimum(current, {
        ...evidence,
        release: { ...evidence.release, published_at: null },
      }),
    ).toBe(false);
  });
  it('rejects forged identity, version, invalid or lowered minimum, and edited or deleted history', () => {
    for (const mutation of [
      { manifest: { ...current.manifest, id: 'other' } },
      { package: { version: '2.3.3' } },
      { manifest: { ...current.manifest, minAppVersion: '1.6.0' } },
      { manifest: { ...current.manifest, minAppVersion: '01.11.5' } },
      { versions: { '2.3.2': '1.7.2' } },
      { versions: { ...current.versions, '2.3.1': '1.11.5' } },
      { versions: { ...current.versions, '2.3.3': '1.11.5' } },
    ])
      expect(acceptsDevelopmentMinimum({ ...current, ...mutation }, evidence)).toBe(false);
  });
});
