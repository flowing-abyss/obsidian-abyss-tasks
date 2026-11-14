import { expect, it } from 'vitest';
import { atomDateTime } from '../src/tasks/domain/commentTimestamp';
import { TaskBlockEditor } from '../src/tasks/infrastructure/markdown/TaskBlockEditor';
import { TaskMarkdownCodec } from '../src/tasks/infrastructure/markdown/TaskMarkdownCodec';
import { corpus, selectCases } from './command-live/corpus';
import { qualificationCases } from './command-live/qualificationCases';
import {
  hasSourceAbsenceFacts,
  hasSourceDestination,
  hasSourceFacts,
} from './command-live/sourceOracle';
import { canonicalStatusCatalog, expectDefined } from './helpers';

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
  expect(corpus).toHaveLength(195);
  expect(new Set(corpus.map((test) => test.id)).size).toBe(195);
});

it('keeps all actor projections and unrelated fixture hashes bound to the frozen definition', async () => {
  const digest = async (value: unknown) => {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    const result = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(result)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  };
  const rows = await Promise.all(
    corpus.map(async (test) => {
      const actorProjection = {
        ...test,
        turns: test.turns.map(({ expect: _expected, ...rest }) => rest),
      };
      return {
        id: test.id,
        fixtureHash: await digest(test),
        actorProjectionHash: await digest(actorProjection),
      };
    }),
  );
  const qualifications = corpus.filter((test) => test.id.startsWith('q6-h'));
  const h02 = expectDefined(rows.find((row) => row.id === 'q6-h02-child-delete-en'));
  expect(await digest(rows.map(({ id, actorProjectionHash }) => [id, actorProjectionHash]))).toBe(
    '98f74853380e35dee85cdb4f4413e2b48dbcd33fe8ea63ce40167375180fb1dc',
  );
  expect(
    await digest(
      rows
        .filter((row) => row.id !== 'q6-h02-child-delete-en')
        .map(({ id, fixtureHash }) => [id, fixtureHash]),
    ),
  ).toBe('8ada1e806d20c5277c41b40c26cc3b64368607f4451592fe7953dcf5f5224a4b');
  expect(h02.fixtureHash).toBe('25daeee2267d24155d873bfa983c4a76f0f677c658a81c6cfd8eb46f9a2e8038');
  expect(await digest(qualifications)).toBe(
    '4cea47769ad96511712e5925dd395cce3e67060c7db7e9f18845736d4d06c8b9',
  );
});

it('binds the H02 removed-node path to its original source child order', () => {
  const h02 = expectDefined(
    qualificationCases.find((test) => test.id === 'q6-h02-child-delete-en'),
  );
  const preview = expectDefined(h02.turns[0]).expect;
  const sourceRoot = (preview.publicTrees?.[0] ?? {}) as {
    markdownTitle?: string;
    children?: Array<{ markdownTitle?: string }>;
  };
  expect(sourceRoot.markdownTitle).toBe('Prepare the North Pier inspection');
  expect(sourceRoot.children?.map((child) => child.markdownTitle)).toEqual([
    'Photograph the ladder',
    'Return the access key',
    'Confirm the tide window',
  ]);
  expect(preview.removedNodes).toEqual([[0, 1]]);
  expect(
    (preview.trees?.[0] as { children?: Array<{ markdownTitle?: string }> }).children?.map(
      (child) => child.markdownTitle,
    ),
  ).toEqual(['Photograph the ladder', 'Confirm the tide window']);
});

function native9Fixture() {
  const item = selectCases('research-native-dictation-comments-ru')[0];
  if (item === undefined) throw new Error('Missing Native9 fixture');
  return item;
}

it('selects the faithful Native9 Russian dictation development fixture', () => {
  const item = native9Fixture();
  const turn = expectDefined(item.turns[0]);
  const page = expectDefined(item.pageFixture);
  expect(item.split).toBe('development');
  expect(item.turns).toHaveLength(1);
  expect(turn.text).toHaveLength(1304);
  expect(turn.expect).toMatchObject({
    status: 'ready',
    proposalKinds: ['task'],
    researchCalls: 1,
    researchPage:
      'https://raw.githubusercontent.com/flowing-abyss/obsidian-abyss-tasks/master/README.md',
    writeCount: 0,
  });
  expect(page.content).toHaveLength(5216);
  expect(item.files['Projects QA/Regular Project.md']).toContain(
    '- [/] Ready task with priority and tags #work/dev #next 🔼 🛫 2026-09-20 📅 2026-09-24 🆔 qa-ready\n',
  );
});

it('targets the existing qa-ready owner and keeps every QA fixture task in the readback', () => {
  const item = native9Fixture();
  const turn = expectDefined(item.turns[0]);
  const owner = turn.expect.trees?.[0] as {
    markdownTitle?: string;
    statusSymbol?: string;
    priority?: string;
    tags?: string[];
    dates?: { start?: string; due?: string };
    authoredId?: string;
    comments?: Array<{ text?: { sourceText?: string } }>;
  };
  expect(owner).toMatchObject({
    markdownTitle: 'Ready task with priority and tags',
    statusSymbol: '/',
    priority: 'C',
    tags: ['#work/dev', '#next'],
    dates: { start: '2026-09-20', due: '2026-09-24' },
    authoredId: 'qa-ready',
  });
  expect(owner.comments?.map((comment) => comment.text?.sourceText)).toEqual(
    Array.from({ length: 3 }, () => item.pageFixture?.url),
  );
  const publicTrees = (turn.expect.publicTrees ?? []) as Array<{
    markdownTitle?: string;
    authoredId?: string;
  }>;
  expect(publicTrees.map(({ markdownTitle, authoredId }) => [markdownTitle, authoredId])).toEqual([
    ['Ready task with priority and tags', 'qa-ready'],
    ['Blocked task with valid dependency', 'qa-blocked'],
    ['Invalid dependency diagnostic', 'qa-invalid'],
    ['In progress task', 'abyss-1vk3nzn15m38pz0gexy001tept8l'],
    ['Completed fixture task', undefined],
    ['Cancelled fixture task', undefined],
  ]);
  expect(turn.expect.taskSources).toEqual([
    { path: 'Projects QA/Regular Project.md', line: 8, kind: 'edit' },
  ]);
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
