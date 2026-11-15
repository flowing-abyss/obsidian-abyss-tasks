import type { EvalCase } from './corpus';
import { files, tree } from './fixtures';

const withoutChildren = (value: ReturnType<typeof tree>) =>
  Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'children'));
const workFile =
  '# Community work\n' +
  '- [ ] Organize the Eastmere canal-path cleanup #civic ⏳ 2027-05-10 📅 2027-05-17\n' +
  '  - > Use the residents’ group grabbers stored in the North Quay shed.\n' +
  '  - [ ] Confirm access to the North Quay shed #keys\n' +
  '  - Keep the footbridge approach clear for pedestrians.\n' +
  '- [ ] Check the flood-marker cabinet #stewardship 📅 2027-05-24\n' +
  '  - Log missing markers before the inspection.\n';
const registryFile =
  '---\nrecord: EC-7704\n---\n# Equipment register\nByte sentinel: blue-crate/12 | naïve | Ω\nKeep verbatim: [no-reflow]\n';
const rootTitle = 'Organize the Eastmere canal-path cleanup';
const existingRoot = (withSource = false) =>
  tree(rootTitle, {
    tags: ['#civic'],
    dates: { scheduled: '2027-05-10', due: '2027-05-17' },
    description: 'Use the residents’ group grabbers stored in the North Quay shed.',
    children: [tree('Confirm access to the North Quay shed', { tags: ['#keys'] })],
    comments: [{ text: 'Keep the footbridge approach clear for pedestrians.' }],
    ...(withSource ? { source: { path: 'a.md', line: 1 } } : {}),
  });
const neighbor = (withSource = false) =>
  tree('Check the flood-marker cabinet', {
    tags: ['#stewardship'],
    dates: { due: '2027-05-24' },
    comments: [{ text: 'Log missing markers before the inspection.' }],
    ...(withSource ? { source: { path: 'a.md', line: 5 } } : {}),
  });
const fullFiles = files(workFile, { 'Equipment register.md': registryFile });

const eastmereCleanupExpansionCase: EvalCase = {
  id: 'prospective-read-expand-eastmere-cleanup-en',
  family: 'prospective-read-existing-open-goal-expansion',
  split: 'development',
  profile: 'owner',
  files: fullFiles,
  limitations: [
    'The single request naturally asks the actor to read the current saved task before preparing the expansion. Do not require a separate read-only turn, exact response wording, or a specific inspect tool trajectory.',
    'Automatic decomposition checks direct-child count, hierarchy depth, unique nonempty action titles, and no invented scheduling. Independent semantic review must assess practical coverage, specificity, feasibility, duplication, and whether the steps advance this cleanup goal while preserving the existing child, description, and comment.',
    'Do not apply the pottery-booth-specific examples or folding-display criteria from q6-h03. A prospective general open-goal rubric addendum must be frozen and blindly calibrated before any new baseline run.',
    'This case can observe one live path, not prove expansion correctness for every candidate step or exercise future deterministic edge branches. No actor calls are authorized by this draft.',
  ],
  turns: [
    {
      text: 'Before editing the existing task, read “Organize the Eastmere canal-path cleanup” and use its description, shed-access step, and comment as context. Help me get the neighborhood canal path cleaned safely and left tidy for residents. Add two to four useful direct steps that move the work through to that completed outcome, building on the reusable grabbers and the existing shed-access step; add one further level only if it would make a step clearer. Keep the current title, dates, tag, description, shed-access step, and comment unchanged. Don’t invent dates or recurring schedules. Show a draft for review; don’t save or research.',
      expect: {
        status: 'ready',
        trees: [
          withoutChildren(
            tree(rootTitle, {
              tags: ['#civic'],
              dates: { scheduled: '2027-05-10', due: '2027-05-17' },
              description: 'Use the residents’ group grabbers stored in the North Quay shed.',
              comments: [{ text: 'Keep the footbridge approach clear for pedestrians.' }],
            }),
          ),
        ],
        publicTrees: [existingRoot(true), neighbor(true)],
        taskSources: [{ path: 'a.md', line: 1, kind: 'edit' }],
        proposalKinds: ['task'],
        freshPreparation: true,
        decomposition: { minChildren: 3, maxChildren: 5, maxDepth: 2, noInventedSchedule: true },
        researchCalls: 0,
        writeCount: 0,
        files: fullFiles,
      },
    },
  ],
};

export { eastmereCleanupExpansionCase };
