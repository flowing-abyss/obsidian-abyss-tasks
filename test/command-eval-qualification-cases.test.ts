import { expect, it } from 'vitest';
import { atomDateTime } from '../src/tasks/domain/commentTimestamp';
import { TaskBlockEditor } from '../src/tasks/infrastructure/markdown/TaskBlockEditor';
import { TaskMarkdownCodec } from '../src/tasks/infrastructure/markdown/TaskMarkdownCodec';
import { corpus } from './command-live/corpus';
import { qualificationCases } from './command-live/qualificationCases';
import {
  hasSourceAbsenceFacts,
  hasSourceDestination,
  hasSourceFacts,
} from './command-live/sourceOracle';
import { canonicalStatusCatalog } from './helpers';

interface SourceCommentMatcher {
  sourceText: string;
  maxLength: number;
  facts: ReadonlyArray<readonly string[]>;
  absenceFacts: ReadonlyArray<ReadonlyArray<readonly string[]>>;
  excludes: readonly string[];
}

type FixtureCommentMatcher = Partial<SourceCommentMatcher>;

const h08AbsenceFacts = [
  [['shared', 'editing']],
  [
    ['cloud', 'synchronization'],
    ['cloud', 'sync'],
  ],
];

function h08LimitationsCommentMatcher(): FixtureCommentMatcher {
  const item = qualificationCases.find((test) => test.id === 'q6-h08-research-field-guide-en');
  const root = item?.turns[0]?.expect.trees?.[0] as
    { comments?: Array<{ text?: FixtureCommentMatcher }> } | undefined;
  return root?.comments?.[1]?.text ?? {};
}

function expectedH08LimitationsComment(): SourceCommentMatcher {
  const matcher = h08LimitationsCommentMatcher();
  const { sourceText, maxLength } = matcher;
  if (typeof sourceText !== 'string') throw new Error('Missing H08 source URL');
  if (typeof maxLength !== 'number') throw new Error('Missing H08 comment limit');
  return {
    sourceText,
    maxLength,
    facts: matcher.facts ?? [],
    absenceFacts: matcher.absenceFacts ?? [],
    excludes: matcher.excludes ?? [],
  };
}

function matchesExpectedSourceComment(matcher: SourceCommentMatcher, text: string): boolean {
  return (
    text.trim().length > matcher.sourceText.length &&
    text.length <= matcher.maxLength &&
    hasSourceDestination(text, matcher.sourceText) &&
    hasSourceFacts(text, matcher.facts, matcher.excludes) &&
    hasSourceAbsenceFacts(text, matcher.absenceFacts)
  );
}

it('adds fourteen distinct held-out cases', () => {
  expect(qualificationCases).toHaveLength(14);
  expect(new Set(qualificationCases.map((test) => test.id)).size).toBe(14);
  expect(qualificationCases.every((test) => test.split === 'held-out')).toBe(true);
});

it('keeps the planned seven Russian and seven English cases', () => {
  expect(qualificationCases.filter((test) => test.id.endsWith('-ru'))).toHaveLength(7);
  expect(qualificationCases.filter((test) => test.id.endsWith('-en'))).toHaveLength(7);
});

it('includes fourteen new unique cases after the original resolved corpus', () => {
  expect(corpus).toHaveLength(193);
  expect(new Set(corpus.map((test) => test.id)).size).toBe(193);
});

it('encodes trajectory-neutral stale conflict handling and task-read evidence', () => {
  const stale = qualificationCases.find((test) => test.id === 'q6-h11-stale-readback-en');
  const staleSave = stale?.turns[1]?.expect;
  expect(staleSave).toMatchObject({
    status: 'error',
    statusAlternatives: ['ready', 'question'],
    preservedConflict: true,
  });
  expect(staleSave).not.toHaveProperty('trees');
  expect(staleSave).not.toHaveProperty('writeCount');
  expect(staleSave).not.toHaveProperty('rejectedWrite');
  expect(stale?.turns[3]?.expect.observations).toEqual([{ kind: 'task', path: 'a.md', line: 0 }]);
});

it('leaves H14 material-proposal review to the persisted-owner comparison', () => {
  const partial = qualificationCases.find(
    (test) => test.id === 'q6-h14-partial-field-save-discard-en',
  );
  expect(partial?.profile).toBe('owner');
  expect(partial?.turns[1]?.expect).toMatchObject({ status: 'ready', partialSave: true });
  expect(partial?.turns[2]?.expect).not.toHaveProperty('trees');
  expect(partial?.turns[2]?.expect).not.toHaveProperty('proposalKinds');
});

it('omits unspecified decomposition children and retains the frozen size rubric', () => {
  const decomposition = qualificationCases.find((test) => test.id === 'q6-h03-open-expansion-ru');
  const decompositionPreview = decomposition?.turns[0]?.expect;
  expect(decompositionPreview?.decomposition).toEqual({
    minChildren: 3,
    maxChildren: 5,
    maxDepth: 2,
    noInventedSchedule: true,
  });
  expect(decompositionPreview?.trees?.[0]).not.toHaveProperty('children');
  expect(decomposition?.turns[1]?.expect.publicTrees?.[0]).not.toHaveProperty('children');
});

it('does not reject an accurate negated encryption claim', () => {
  const larkspur = qualificationCases.find((test) => test.id === 'q6-h07-research-dictation-ru');
  const larkspurComments = larkspur?.turns[0]?.expect.trees?.[0] as
    { comments?: Array<{ text?: { excludes?: string[] } }> } | undefined;
  expect(larkspurComments?.comments?.[1]?.text?.excludes ?? []).not.toContain(
    'encrypted by Larkspur',
  );
});

it('checks shared editing and cloud sync as independent facts', () => {
  const matcher = h08LimitationsCommentMatcher();
  expect(matcher.facts).toEqual([
    ['CSV'],
    ['dates', 'dates, locations', 'даты'],
    ['locations', 'локац'],
    ['notes', 'замет'],
    ['separate', 'remain separate', 'отдельно'],
  ]);
  expect(matcher.absenceFacts).toEqual([
    [['shared', 'editing']],
    [
      ['cloud', 'synchronization'],
      ['cloud', 'sync'],
    ],
  ]);
});

it('accepts the source page’s coordinated negation in the H08 comment matcher', () => {
  const matcher = expectedH08LimitationsComment();
  const text =
    'CSV exports dates, locations and notes; photograph files remain separate. There is no shared editing or cloud synchronization. https://manual.tidelark.example/ranger-log';
  expect(text).toHaveLength(169);
  expect(hasSourceAbsenceFacts(text, h08AbsenceFacts)).toBe(true);
  expect(matchesExpectedSourceComment(matcher, text)).toBe(true);
});

it.each([
  'CSV exports dates, locations and notes; photograph files remain separate. There is no shared editing. https://manual.tidelark.example/ranger-log',
  'CSV exports dates, locations and notes; photograph files remain separate. Cloud synchronization is unavailable. https://manual.tidelark.example/ranger-log',
])('requires both H08 absences and rejects an omitted capability: %s', (text) => {
  const matcher = expectedH08LimitationsComment();
  expect(matchesExpectedSourceComment(matcher, text)).toBe(false);
});

it('rejects H08 availability claims, URL-only comments, and a missing citation', () => {
  const matcher = expectedH08LimitationsComment();
  const falseAvailability =
    'CSV exports dates, locations and notes; photograph files remain separate. There is no shared editing. Cloud synchronization is available. https://manual.tidelark.example/ranger-log';
  const urlOnly = 'https://manual.tidelark.example/ranger-log';
  const missingCitation =
    'CSV exports dates, locations and notes; photograph files remain separate. There is no shared editing or cloud synchronization.';
  expect(hasSourceAbsenceFacts(falseAvailability, h08AbsenceFacts)).toBe(false);
  expect(matchesExpectedSourceComment(matcher, falseAvailability)).toBe(false);
  expect(matchesExpectedSourceComment(matcher, urlOnly)).toBe(false);
  expect(matchesExpectedSourceComment(matcher, missingCitation)).toBe(false);
});

it('rejects each missing capability in the H08 absence groups', () => {
  expect(hasSourceAbsenceFacts('There is no shared editing.', h08AbsenceFacts)).toBe(false);
  expect(hasSourceAbsenceFacts('Cloud synchronization is unavailable.', h08AbsenceFacts)).toBe(
    false,
  );
  expect(
    hasSourceAbsenceFacts(
      'There is no shared editing. Cloud synchronization is unavailable.',
      h08AbsenceFacts,
    ),
  ).toBe(true);
});

it('checks canonical markers and shifted zero-based lines with separate synthetic data', () => {
  const codec = new TaskMarkdownCodec(canonicalStatusCatalog());
  const markerEdit = codec.applyLineEdits('- [ ] Calibrate the lake meter #water', [
    { type: 'set-duration', value: 75 },
    { type: 'set-date', field: 'scheduled', value: '2027-01-14' },
    { type: 'set-date', field: 'due', value: '2027-01-18' },
  ]);
  expect(markerEdit.type).toBe('changed');
  if (markerEdit.type !== 'changed') throw new Error('Synthetic marker edit did not change');
  expect(markerEdit.content).toContain('⏱️ 1h15m');
  expect(markerEdit.content).toContain('⏳ 2027-01-14');
  expect(markerEdit.content).toContain('📅 2027-01-18');

  const editor = new TaskBlockEditor();
  const before =
    '# Lake survey\n- [ ] Calibrate the lake meter #water\n- [ ] File the sample log #records\n';
  const [meter, log] = editor.rootBlocks(before);
  expect([meter?.line, log?.line]).toEqual([1, 2]);
  const commentEdit =
    meter === undefined
      ? undefined
      : editor.edit(
          before,
          meter,
          { relativeLine: 0, lineCount: 1, childRanges: [] },
          {
            type: 'add-comment',
            text: 'Confirm the meter reading',
            stamp: atomDateTime('2026-11-11T10:15'),
          },
        );
  expect(commentEdit?.type).toBe('changed');
  if (commentEdit?.type !== 'changed') throw new Error('Synthetic comment edit did not change');
  expect(editor.rootBlocks(commentEdit.content).map((block) => block.line)).toEqual([1, 3]);
});
