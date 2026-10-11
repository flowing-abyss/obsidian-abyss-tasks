// @vitest-environment node
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  projectSearchText,
  searchTextSourceRanges,
  type SearchTextValue,
} from '../src/markdown/searchText';
import { expectDefined } from './helpers';

interface AuthoredValue {
  text: string;
  origins: Array<{ from: number; to: number }>;
}
interface ProjectionFixture {
  source: string;
  visible: AuthoredValue;
  destinations: AuthoredValue[];
}

// Record UTF-16 units as the source is authored, without reading production projection fields.
function authorProjection(label: string, destination: string, prose: boolean): ProjectionFixture {
  const fixture: ProjectionFixture = {
    source: '',
    visible: { text: '', origins: [] },
    destinations: [],
  };
  function text(value: string, from: number, target = fixture.visible): void {
    target.text += value;
    for (let unit = 0; unit < value.length; unit++)
      target.origins.push({ from: from + unit, to: from + unit + 1 });
  }
  function literal(value: string): void {
    text(value, fixture.source.length);
    fixture.source += value;
  }
  function link(wiki: boolean): void {
    const at = fixture.source.length;
    const token = wiki ? `[[${destination}|${label}]]` : `[${label}](${destination})`;
    text(label, at + (wiki ? destination.length + 3 : 1));
    const target: AuthoredValue = { text: '', origins: [] };
    text(destination, at + (wiki ? 2 : label.length + 3), target);
    fixture.destinations.push(target);
    fixture.source += token;
  }
  literal('😀 e\u0301 ');
  link(true);
  literal(' ');
  link(false);
  literal(' ');
  const codeAt = fixture.source.length;
  fixture.source += `\` ${label}\r\n${label} \``;
  text(label, codeAt + 2);
  fixture.visible.text += ' ';
  fixture.visible.origins.push({ from: codeAt + label.length + 2, to: codeAt + label.length + 4 });
  text(label, codeAt + label.length + 4);
  literal(' ');
  const escapedAt = fixture.source.length;
  fixture.source += `\\[${label}](${destination})`;
  fixture.visible.text += '[';
  fixture.visible.origins.push({ from: escapedAt, to: escapedAt + 2 });
  text(`${label}](${destination})`, escapedAt + 2);
  if (prose) {
    literal(' ');
    // This closed comment owns its interior links/code; neither becomes a destination.
    fixture.source += `<!-- [[${destination}|hidden]] \`secret\` <b> -->`;
    literal(' ');
    const escapedCommentAt = fixture.source.length;
    fixture.source += '\\<!-- <b>kept</b> -->';
    fixture.visible.text += '<';
    fixture.visible.origins.push({ from: escapedCommentAt, to: escapedCommentAt + 2 });
    text('!-- <b>kept</b> -->', escapedCommentAt + 2);
    literal(' ');
    // An incomplete comment remains visible while its independently recognized tags disappear.
    literal('<!-- open ');
    fixture.source += '<b>';
    literal(label);
    fixture.source += '</b>';
    literal(' tail');
  }
  return fixture;
}

function expectAuthoredValue(actual: SearchTextValue, authored: AuthoredValue): void {
  expect(actual.text).toBe(authored.text);
  for (const [unit, origin] of authored.origins.entries()) {
    expect(searchTextSourceRanges(actual, { from: unit, to: unit + 1 })).toEqual([origin]);
  }
}

const labels = fc
  .array(fc.constantFrom('Я', 'e\u0301', '😀Я', '日本語', '𐐀word'), { minLength: 1, maxLength: 4 })
  .map((parts) => parts.join(''));
const destinations = fc
  .tuple(fc.constantFrom('Folder/', 'Я/', '😀/'), labels)
  .map(([prefix, label]) => `${prefix}${label}.md#H`);

describe('independently authored search origins', () => {
  it('uses UTF-16 source units after an astral prefix and a wiki alias', () => {
    const source = '😀 [[N|Я]]';
    const value = projectSearchText(source, 'title').visible;
    expect(value.text).toBe('😀 Я');
    expect(searchTextSourceRanges(value, { from: 3, to: 4 })).toEqual([{ from: 7, to: 8 }]);
  });

  it.each(['title', 'prose'] as const)(
    'preserves generated %s text, destinations and every authored origin',
    (presentation) => {
      fc.assert(
        fc.property(labels, destinations, (label, destination) => {
          const fixture = authorProjection(label, destination, presentation === 'prose');
          const actual = projectSearchText(fixture.source, presentation);
          expectAuthoredValue(actual.visible, fixture.visible);
          expect(actual.destinations).toHaveLength(fixture.destinations.length);
          for (const [position, authored] of fixture.destinations.entries()) {
            expectAuthoredValue(expectDefined(actual.destinations[position]), authored);
          }
        }),
        { seed: 20261012, numRuns: 200 },
      );
    },
  );
});
