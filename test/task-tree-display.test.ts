import { Component, type App } from 'obsidian';
import { afterEach, expect, it, vi } from 'vitest';
import {
  mountTaskTreeDisplay,
  type TaskDisplayField,
  type TaskDisplayNode,
} from '../src/ui/taskTreeDisplay';
import { expectDefined } from './helpers';
import { mockReadingView } from './support/linkEditHarness';
const owners: Component[] = [];
afterEach(() => {
  owners.splice(0).forEach((owner) => {
    owner.unload();
  });
  document.body.empty();
  vi.restoreAllMocks();
});
function field(
  key: string,
  markdown: string,
  presentation: 'title' | 'description' | 'markdown' = 'title',
): TaskDisplayField {
  return {
    key,
    input: {
      source: { target: { type: 'display', key }, markdown, path: 'Inbox.md', presentation },
      decoration: { kind: 'complete' },
      callbacks: { app: {} as App, isCurrent: () => true },
    },
  };
}
function node(
  key: string,
  title: string,
  entries: TaskDisplayNode['entries'] = [],
): TaskDisplayNode {
  return {
    kind: 'task',
    key,
    identity: { type: 'display', key },
    title: field(`${key}:title`, title),
    entries,
    complete: true,
    done: false,
    onActivate: () => {},
  };
}
function setup(roots: TaskDisplayNode[]) {
  const owner = new Component();
  owner.load();
  owners.push(owner);
  const host = document.body.createDiv();
  const options = { owner, roots, isCurrent: () => true };
  return { host, options, mount: mountTaskTreeDisplay(host, options) };
}
it('retains title, description and exact nested comment hosts while only metadata changes', async () => {
  const comment = {
    kind: 'comment' as const,
    key: 'c',
    field: field('c', 'Owned by second', 'markdown'),
  };
  const second = {
    ...node('second', 'Duplicate', [comment]),
    description: field('second:description', 'Details', 'description'),
  };
  const h = setup([node('root', 'Parent', [node('first', 'Duplicate'), second])]);
  await h.mount.settled;
  const row = expectDefined(h.host.querySelector('[data-task-display-key="second"]'));
  const title = row.querySelector('.abyss-subtask-label');
  const description = row.querySelector('.abyss-task-desc');
  const commentEl = row.querySelector('.abyss-comment-text');
  expect(row.textContent).toBe('DuplicateDetailsOwned by second');
  expect(h.host.querySelector('[data-task-display-key="first"]')?.textContent).toBe('Duplicate');
  h.host.scrollTop = 33;
  h.mount.update({
    ...h.options,
    roots: [
      node('root', 'Parent', [
        node('first', 'Duplicate'),
        {
          ...second,
          renderHeader: (host) => {
            host.dataset['date'] = '2026-11-09';
          },
        },
      ]),
    ],
  });
  await h.mount.settled;
  expect(h.host.querySelector('[data-task-display-key="second"]')).toBe(row);
  expect(row.querySelector('.abyss-subtask-label')).toBe(title);
  expect(row.querySelector('.abyss-task-desc')).toBe(description);
  expect(row.querySelector('.abyss-comment-text')).toBe(commentEl);
  expect(h.host.scrollTop).toBe(33);
});
it('reuses canonical mixed order, updates activation bindings and retires disposed fields', async () => {
  const activated: string[] = [];
  const h = setup([
    {
      ...node('r', 'Root', [
        node('a', 'A'),
        { kind: 'comment', key: 'c', field: field('c', 'Between', 'markdown') },
        node('b', 'B'),
      ]),
      onActivate: () => activated.push('old'),
    },
  ]);
  await h.mount.settled;
  expect(h.host.textContent).toBe('RootABetweenB');
  h.mount.update({
    ...h.options,
    roots: [{ ...node('r', 'Root'), onActivate: () => activated.push('current') }],
  });
  await h.mount.settled;
  const title = expectDefined(h.host.querySelector<HTMLElement>('.abyss-task-title'));
  title.click();
  expect(activated).toEqual(['current']);
  h.mount.destroy();
  title.click();
  expect(activated).toEqual(['current']);
  expect(h.host.textContent).toBe('');
});

it.each([false, true])(
  'updates date metadata while retaining focused tag chips (complete planning: %s)',
  async (completePlanning) => {
    const { mountTaskMetadataDisplay } = await import('../src/ui/taskMetadataDisplay');
    const { localDate } = await import('../src/tasks');
    const owner = new Component();
    owner.load();
    owners.push(owner);
    const host = document.body.createDiv();
    const options = {
      owner,
      suppressToday: false,
      completePlanning,
      formatDate: (date: string) => date,
      getDateClass: () => '',
      getTagColor: () => undefined,
      showSource: () => true,
    };
    const mount = mountTaskMetadataDisplay(
      host,
      { planning: { scheduled: localDate('2026-11-08') }, tags: ['#stable'], sourcePath: 'a.md' },
      options,
    );
    const tag = expectDefined(host.querySelector<HTMLElement>('.abyss-task-tag'));
    const source = host.querySelector('.abyss-task-source-note');
    tag.tabIndex = 0;
    tag.focus();
    mount.update(
      { planning: { scheduled: localDate('2026-11-09') }, tags: ['#stable'], sourcePath: 'a.md' },
      options,
    );
    expect(host.querySelector('.abyss-task-tag')).toBe(tag);
    expect(host.querySelector('.abyss-task-source-note')).toBe(source);
    expect(document.activeElement).toBe(tag);
    expect(host.textContent).toContain('2026-11-09');
    expect(host.textContent).not.toContain('2026-11-08');
  },
);

it('renders changed text beside its inert old fragment without rebuilding a retained title on metadata updates', async () => {
  const title = field('task:title', 'Ship 🧭 safely');
  const changed: TaskDisplayField = {
    ...title,
    change: 'changed',
    input: { ...title.input, decoration: { kind: 'complete', previousMarkdown: 'Ship 🚀 safely' } },
  };
  const root = { ...node('task', 'Ship 🧭 safely'), title: changed };
  const h = setup([root]);
  await h.mount.settled;
  const host = expectDefined(h.host.querySelector<HTMLElement>('.abyss-task-title'));
  expect(host.querySelector('del')?.textContent).toBe('🚀');
  expect(host.querySelector('del')?.inert).toBe(true);
  expect(host.querySelector('ins')?.textContent).toBe('🧭');
  expect(host.textContent).toBe('Ship 🚀🧭 safely');
  const insertion = host.querySelector('ins');
  h.mount.update({
    ...h.options,
    roots: [
      {
        ...root,
        renderHeader: (header) => {
          header.dataset['date'] = '2026-08-03';
        },
      },
    ],
  });
  await h.mount.settled;
  expect(host.querySelector('ins')).toBe(insertion);
  h.mount.update({ ...h.options, roots: [{ ...root, title }] });
  await h.mount.settled;
  expect(host.querySelector('del, ins')).toBeNull();
  expect(host.textContent).toBe('Ship 🧭 safely');
});

it('keeps native wiki-link handlers while marking only a changed visible label', async () => {
  mockReadingView();
  const base = field('link:title', 'Read [[Docs|blue guide]] today');
  const guard = vi.fn(async () => false);
  const title: TaskDisplayField = {
    ...base,
    change: 'changed',
    input: {
      ...base.input,
      decoration: { kind: 'complete', previousMarkdown: 'Read [[Docs|red guide]] today' },
      callbacks: { ...base.input.callbacks, beforeOpenLink: guard },
    },
  };
  const h = setup([{ ...node('link', 'Ignored'), title }]);
  await h.mount.settled;
  const anchor = expectDefined(h.host.querySelector<HTMLAnchorElement>('a'));
  expect(anchor.getAttribute('data-href')).toBe('Docs');
  expect(h.host.querySelector('del')?.textContent).toBe('red');
  expect(anchor.querySelector('ins')?.textContent).toBe('blue');
  expect(anchor.closest('[aria-description="changed"]')).not.toBeNull();
  anchor.click();
  await Promise.resolve();
  expect(guard).toHaveBeenCalledOnce();
  h.mount.update({ ...h.options, roots: [{ ...node('link', 'Ignored'), title }] });
  await h.mount.settled;
  expect(h.host.querySelector('a')).toBe(anchor);
});

it.each([false, true])(
  'defers verified removal only with motion enabled, skips unchanged geometry and disposes (reduced=%s)',
  async (reduced) => {
    const previous = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate');
    const media = Object.getOwnPropertyDescriptor(window, 'matchMedia');
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({ matches: reduced }),
    });
    const completed: Array<() => void> = [];
    const cancel = vi.fn();
    const animate = vi.fn(
      () =>
        ({
          cancel,
          finished: new Promise<void>((resolve) => {
            completed.push(resolve);
          }),
        }) as unknown as Animation,
    );
    Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate });
    try {
      const h = setup([node('one', 'One'), node('two', 'Two')]);
      await h.mount.settled;
      h.mount.update({ ...h.options, motion: true });
      await h.mount.settled;
      const geometry = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect');
      geometry.mockClear();
      h.mount.update({
        ...h.options,
        motion: true,
        roots: [node('one', 'One'), node('two', 'Two')],
      });
      await h.mount.settled;
      expect(geometry).not.toHaveBeenCalled();
      h.mount.update({ ...h.options, motion: true, roots: [node('two', 'Two')] });
      await Promise.resolve();
      await Promise.resolve();
      if (reduced) {
        await h.mount.settled;
        expect(animate).not.toHaveBeenCalled();
        expect(h.host.querySelector('[data-task-display-key="one"]')).toBeNull();
        h.mount.destroy();
        return;
      }
      const outgoing = h.host.querySelector<HTMLElement>('[data-task-display-key="one"]');
      expect(outgoing?.inert).toBe(true);
      expect(animate).toHaveBeenCalled();
      completed.splice(0).forEach((resolve) => {
        resolve();
      });
      await h.mount.settled;
      expect(h.host.querySelector('[data-task-display-key="one"]')).toBeNull();
      h.mount.update({
        ...h.options,
        motion: true,
        roots: [node('two', 'Two'), node('three', 'Three')],
      });
      await h.mount.settled;
      h.mount.destroy();
      expect(cancel).toHaveBeenCalled();
    } finally {
      if (media === undefined) Reflect.deleteProperty(window, 'matchMedia');
      else Object.defineProperty(window, 'matchMedia', media);
      if (previous === undefined) Reflect.deleteProperty(HTMLElement.prototype, 'animate');
      else Object.defineProperty(HTMLElement.prototype, 'animate', previous);
    }
  },
);

it.each([
  [
    'Проверить календарь',
    'Подготовить план недели',
    'Проверить календарь',
    'Подготовить план недели',
  ],
  ['Keep planning today', 'Keep running today', 'planning', 'running'],
])('keeps readable whole-word fragments for %s → %s', async (before, after, removed, inserted) => {
  const title = field('word:title', after);
  const h = setup([
    {
      ...node('word', after),
      title: {
        ...title,
        input: { ...title.input, decoration: { kind: 'complete', previousMarkdown: before } },
      },
    },
  ]);
  await h.mount.settled;
  expect(h.host.querySelector('del')?.textContent).toBe(removed);
  expect(h.host.querySelector('ins')?.textContent).toBe(inserted);
});
