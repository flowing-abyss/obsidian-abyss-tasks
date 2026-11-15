import type { EvalCase } from './corpus';
import { files, tree } from './fixtures';

const noPendingTitleCancelCase: EvalCase = {
  id: 'prospective-no-pending-title-cancel-en',
  family: 'prospective-no-pending-feedback',
  split: 'development',
  profile: 'owner',
  files: files(
    '# Field work\n- [ ] Check the Ternway field relay #radio/maintenance 📅 2027-04-07\n  - Keep the bench sketch folded with the inspection sheet.\n- [ ] Keep the sealed amber fuse kit #inventory 📅 2027-04-11\n  - Leave the tamper strip intact.\n',
    {
      'Registry card.md':
        '---\ncard: RF-4819\n---\n# Registry card\nByte sentinel: spool/09 | façade | Ω\nRetain this line exactly: [do-not-normalize]\n',
    },
  ),
  limitations: [
    'The final turn must receive unchanged independent semantic review for truthful, nonempty acknowledgement in the active session and no Save invitation. The case does not require exact acknowledgement wording.',
    'Both a canonical full-no-op restoration and a successful session discard are acceptable. The expectations intentionally omit proposalKinds and focus on the final turn so neither mechanism is prescribed.',
    'This six-SDK live case can observe one actor path only. Future deterministic tests must cover both branches and partial-prior-save receipt retention separately; the case does not claim those branches were executed.',
  ],
  turns: [
    {
      text: 'For the existing task “Check the Ternway field relay” in Field work, change only its title to “Inspect the Ternway field relay housing” and show me the draft. Keep its due date, tag, and comment exactly as they are, along with the sealed fuse task and Registry card.md. Do not save or research anything.',
      expect: {
        status: 'ready',
        trees: [
          tree('Inspect the Ternway field relay housing', {
            tags: ['#radio/maintenance'],
            dates: { due: '2027-04-07' },
            comments: [{ text: 'Keep the bench sketch folded with the inspection sheet.' }],
          }),
        ],
        publicTrees: [
          tree('Check the Ternway field relay', {
            tags: ['#radio/maintenance'],
            dates: { due: '2027-04-07' },
            comments: [{ text: 'Keep the bench sketch folded with the inspection sheet.' }],
            source: { path: 'a.md', line: 1 },
          }),
          tree('Keep the sealed amber fuse kit', {
            tags: ['#inventory'],
            dates: { due: '2027-04-11' },
            comments: [{ text: 'Leave the tamper strip intact.' }],
            source: { path: 'a.md', line: 3 },
          }),
        ],
        taskSources: [{ path: 'a.md', line: 1, kind: 'edit' }],
        proposalKinds: ['task'],
        freshPreparation: true,
        researchCalls: 0,
        writeCount: 0,
        files: {
          'a.md':
            '# Field work\n- [ ] Check the Ternway field relay #radio/maintenance 📅 2027-04-07\n  - Keep the bench sketch folded with the inspection sheet.\n- [ ] Keep the sealed amber fuse kit #inventory 📅 2027-04-11\n  - Leave the tamper strip intact.\n',
          'control.md':
            '---\nprotected: true\n---\n# Control\r\n- [ ] Untouched [unknown:: keep] #control\r\n',
          'Registry card.md':
            '---\ncard: RF-4819\n---\n# Registry card\nByte sentinel: spool/09 | façade | Ω\nRetain this line exactly: [do-not-normalize]\n',
        },
      },
    },
    {
      text: 'Cancel that draft title change and restore the original title “Check the Ternway field relay”. Keep its due date, tag, and comment, the sealed fuse task, and Registry card.md unchanged. Do not save anything.',
      expect: {
        status: 'ready',
        pendingTaskStates: [
          {
            path: 'a.md',
            line: 1,
            tree: tree('Check the Ternway field relay', {
              tags: ['#radio/maintenance'],
              dates: { due: '2027-04-07' },
              comments: [{ text: 'Keep the bench sketch folded with the inspection sheet.' }],
            }),
          },
        ],
        publicTrees: [
          tree('Check the Ternway field relay', {
            tags: ['#radio/maintenance'],
            dates: { due: '2027-04-07' },
            comments: [{ text: 'Keep the bench sketch folded with the inspection sheet.' }],
            source: { path: 'a.md', line: 1 },
          }),
          tree('Keep the sealed amber fuse kit', {
            tags: ['#inventory'],
            dates: { due: '2027-04-11' },
            comments: [{ text: 'Leave the tamper strip intact.' }],
            source: { path: 'a.md', line: 3 },
          }),
        ],
        researchCalls: 0,
        writeCount: 0,
        files: {
          'a.md':
            '# Field work\n- [ ] Check the Ternway field relay #radio/maintenance 📅 2027-04-07\n  - Keep the bench sketch folded with the inspection sheet.\n- [ ] Keep the sealed amber fuse kit #inventory 📅 2027-04-11\n  - Leave the tamper strip intact.\n',
          'control.md':
            '---\nprotected: true\n---\n# Control\r\n- [ ] Untouched [unknown:: keep] #control\r\n',
          'Registry card.md':
            '---\ncard: RF-4819\n---\n# Registry card\nByte sentinel: spool/09 | façade | Ω\nRetain this line exactly: [do-not-normalize]\n',
        },
      },
    },
  ],
};

export { noPendingTitleCancelCase };
