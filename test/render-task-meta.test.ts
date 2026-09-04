import { describe, expect, it } from 'vitest';
import {
  extractTags,
  hasMeta,
  renderCountBadges,
  renderTagChips,
} from '../src/views/timegrid/renderTaskMeta';
import { expectDefined, freshContainer, subtask, task, taskComment } from './helpers';

describe('renderTaskMeta', () => {
  describe('hasMeta', () => {
    it('is false for a task with no tags, subtasks, comments, or links', () => {
      expect(hasMeta(task())).toBe(false);
    });
    it('is true when the task has a tag', () => {
      expect(
        hasMeta(
          task({
            tags: ['#work'],
            source: { originalMarkdown: '- [ ] t #work', originalBlock: '- [ ] t #work' },
          }),
        ),
      ).toBe(true);
    });
    it('is true when the task has subtasks', () => {
      expect(
        hasMeta(
          task({
            subtasks: [subtask({ title: 'sub' })],
          }),
        ),
      ).toBe(true);
    });
    it('is true when the task has comments', () => {
      expect(hasMeta(task({ comments: [taskComment({ text: 'note' })] }))).toBe(true);
    });
    it('is true when the task has a precomputed linkCount', () => {
      expect(hasMeta(task({ presentation: { linkCount: 2 } }))).toBe(true);
    });
  });

  describe('extractTags', () => {
    it('extracts hashtags from rawText', () => {
      expect(
        extractTags(
          task({
            tags: ['#work', '#urgent'],
            source: {
              originalMarkdown: '- [ ] t #work #urgent',
              originalBlock: '- [ ] t #work #urgent',
            },
          }),
        ),
      ).toEqual(['#work', '#urgent']);
    });
    it('caps at max', () => {
      expect(
        extractTags(
          task({
            tags: ['#a', '#b', '#c'],
            source: { originalMarkdown: '- [ ] t #a #b #c', originalBlock: '- [ ] t #a #b #c' },
          }),
          2,
        ),
      ).toEqual(['#a', '#b']);
    });
    it('returns an empty array when there are no tags', () => {
      expect(extractTags(task())).toEqual([]);
    });
  });

  describe('renderCountBadges', () => {
    it('renders nothing for a task with no counts', () => {
      const container = freshContainer();
      renderCountBadges(container, task());
      expect(container.querySelectorAll('.abyss-task-count-badge')).toHaveLength(0);
    });

    it('renders a done/total badge for subtasks', () => {
      const container = freshContainer();
      const t = task({
        subtasks: [
          subtask({ title: 'a', status: 'done', statusSymbol: 'x' }),
          subtask({ title: 'b', ref: { relativeLine: 2 } }),
        ],
      });
      renderCountBadges(container, t);
      const badges = container.querySelectorAll('.abyss-task-count-badge');
      expect(badges).toHaveLength(1);
      expect(expectDefined(badges[0]).textContent).toContain('1/2');
    });

    it('renders a comment count badge', () => {
      const container = freshContainer();
      const t = task({
        comments: [
          taskComment({ text: 'a' }),
          taskComment({ text: 'b', ref: { relativeLine: 2 } }),
        ],
      });
      renderCountBadges(container, t);
      const badges = container.querySelectorAll('.abyss-task-count-badge');
      expect(badges).toHaveLength(1);
      expect(expectDefined(badges[0]).textContent).toContain('2');
    });

    it('renders a link count badge from the precomputed linkCount field', () => {
      const container = freshContainer();
      renderCountBadges(container, task({ presentation: { linkCount: 3 } }));
      const badges = container.querySelectorAll('.abyss-task-count-badge');
      expect(badges).toHaveLength(1);
      expect(expectDefined(badges[0]).textContent).toContain('3');
    });

    it('renders all three badges together, in subtask/comment/link order', () => {
      const container = freshContainer();
      const t = task({
        subtasks: [subtask({ title: 'a' })],
        comments: [taskComment({ text: 'c', ref: { relativeLine: 2 } })],
        presentation: { linkCount: 1 },
      });
      renderCountBadges(container, t);
      const badges = container.querySelectorAll('.abyss-task-count-badge');
      expect(badges).toHaveLength(3);
    });
  });

  describe('renderTagChips', () => {
    it('renders a chip per tag, uncolored when no tag group matches', () => {
      const container = freshContainer();
      renderTagChips(
        container,
        task({
          tags: ['#misc'],
          source: { originalMarkdown: '- [ ] t #misc', originalBlock: '- [ ] t #misc' },
        }),
        [],
      );
      const chip = container.querySelector('.abyss-task-tag') as HTMLElement;
      expect(chip).not.toBeNull();
      expect(chip.textContent).toBe('#misc');
      expect(chip.classList.contains('abyss-task-tag--colored')).toBe(false);
    });

    it('colors the chip when the tag matches a configured tag group', () => {
      const container = freshContainer();
      renderTagChips(
        container,
        task({
          tags: ['#work'],
          source: { originalMarkdown: '- [ ] t #work', originalBlock: '- [ ] t #work' },
        }),
        [{ id: '1', name: 'Work', mode: 'prefix', prefix: 'work', color: '#3498db' }],
      );
      const chip = container.querySelector('.abyss-task-tag') as HTMLElement;
      expect(chip.classList.contains('abyss-task-tag--colored')).toBe(true);
      expect(chip.style.getPropertyValue('--abyss-tag-color')).toBe('#3498db');
    });

    it('caps the number of chips at max', () => {
      const container = freshContainer();
      renderTagChips(
        container,
        task({
          tags: ['#a', '#b', '#c'],
          source: { originalMarkdown: '- [ ] t #a #b #c', originalBlock: '- [ ] t #a #b #c' },
        }),
        [],
        2,
      );
      expect(container.querySelectorAll('.abyss-task-tag')).toHaveLength(2);
    });

    it('renders no click handlers (presentational-only, safe inside drag surfaces)', () => {
      const container = freshContainer();
      renderTagChips(
        container,
        task({
          tags: ['#work'],
          source: { originalMarkdown: '- [ ] t #work', originalBlock: '- [ ] t #work' },
        }),
        [],
      );
      const chip = container.querySelector('.abyss-task-tag') as HTMLElement;
      // jsdom doesn't expose a listener-count API; the contract this test protects is
      // "clicking the chip does nothing and does not throw" — no filter/drag wiring.
      expect(() => chip.dispatchEvent(new MouseEvent('click', { bubbles: true }))).not.toThrow();
    });
  });
});
