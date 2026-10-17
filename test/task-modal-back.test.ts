import { Modal } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { InteractionRegistry } from '../src/ui/interactionOwnership';
import { VaultFileSuggestionSource } from '../src/ui/NoteSuggest';
import { TaskModal } from '../src/ui/TaskModal';
import { deferred, expectDefined, flushMicrotasks, useRealMoment } from './helpers';
import { createCanonicalSearchHarness } from './support/taskSearchHarness';

useRealMoment();
vi.mock('../src/ui/textFieldAnchor', () => ({
  textFieldAnchor: () => new DOMRect(100, 100, 1, 20),
  textFieldViewport: () => new DOMRect(0, 0, 1000, 800),
}));
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function fixture() {
  const h = await createCanonicalSearchHarness(
    {
      'tasks.md': '- [ ] Current 🆔 current\n- [ ] Candidate 🆔 candidate',
      'Alpha.md': '',
    },
    DEFAULT_SETTINGS,
  );
  const ownership = new InteractionRegistry();
  const modal = new TaskModal({
    app: h.app,
    statusRegistry: h.statusRegistry,
    settings: DEFAULT_SETTINGS,
    queries: h.index,
    tasks: h.tasks,
    search: h.search,
    interactionOwnership: ownership,
  });
  cleanups.push(() => {
    modal.close();
    h.close();
  });
  const opened = vi.spyOn(Modal.prototype, 'open');
  const current = expectDefined(h.index.list()[0]);
  modal.open(current);
  const host = expectDefined(opened.mock.instances[0]) as Modal;
  const comment = expectDefined(
    host.modalEl.querySelector<HTMLTextAreaElement>('.abyss-comment-input'),
  );
  comment.value = 'Unsubmitted comment';
  return { ...h, modal, host, comment, current, ownership, opened };
}

const surfaces = [
  ['sessions', '.abyss-time-badge-body', '.abyss-time-tracking-popover--sessions'],
  ['dependencies', '.abyss-dep-badge-body', '.abyss-dep-search'],
  ['comment links', '.abyss-comment-input', '.abyss-link-suggest'],
  ['title links', '.abyss-right-title-view', '.abyss-link-suggest'],
] as const;

async function openSurface(host: Modal, entry: readonly [string, string, string]) {
  let opener = expectDefined(host.modalEl.querySelector<HTMLElement>(entry[1]));
  opener.click();
  if (entry[0] === 'title links')
    opener = expectDefined(host.modalEl.querySelector<HTMLElement>('.abyss-right-title-edit'));
  if (entry[0].endsWith('links')) {
    const input = opener as HTMLInputElement | HTMLTextAreaElement;
    input.focus();
    input.value = 'Draft [[Al';
    input.setSelectionRange(input.value.length, input.value.length);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.waitFor(() => {
      expect(document.querySelector('.abyss-link-suggest-option')).not.toBeNull();
    });
  }
  return { opener, surface: expectDefined(document.querySelector<HTMLElement>(entry[2])) };
}

describe('native Back across inspector owners', () => {
  it.each(surfaces)('keeps the existing Escape cancellation and focus for %s', async (...entry) => {
    const h = await fixture();
    const { opener, surface } = await openSurface(h.host, entry);
    const draft = h.comment.value;
    const escape = () => {
      expectDefined(document.activeElement).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    };
    escape();
    if (entry[0] === 'dependencies') {
      expect(surface.isConnected).toBe(true);
      escape();
    }
    expect(surface.isConnected).toBe(false);
    expect(h.host.modalEl.isConnected).toBe(true);
    expect(document.activeElement).toBe(opener);
    expect(h.comment.value).toBe(draft);
  });

  it.each(surfaces)('dismisses %s before the modal and preserves the draft', async (...entry) => {
    const h = await fixture();
    const { opener, surface } = await openSurface(h.host, entry);
    const draft = h.comment.value;

    h.host.onHistoryBack();

    expect(surface.isConnected).toBe(false);
    expect(h.host.modalEl.isConnected).toBe(true);
    expect(document.activeElement).toBe(opener);
    expect(h.comment.value).toBe(draft);
    if (entry[0].endsWith('links')) {
      expect((opener as HTMLInputElement).value).toBe('Draft [[Al');
      expect((opener as HTMLInputElement).selectionStart).toBe(10);
    }

    h.host.onHistoryBack();

    expect(h.host.modalEl.isConnected).toBe(false);
    expect(h.ownership.allows('navigate')).toBe(true);
  });

  it.each(surfaces)(
    'disposes %s unconditionally and isolates replacement hosts',
    async (...entry) => {
      const h = await fixture();
      const first = await openSurface(h.host, entry);
      h.modal.close();
      expect(first.surface.isConnected).toBe(false);
      expect(h.ownership.allows('navigate')).toBe(true);
      h.modal.open(h.current);
      const replacement = expectDefined(h.opened.mock.instances[1]) as Modal;
      const second = await openSurface(replacement, entry);

      h.host.onHistoryBack();

      expect(second.surface.isConnected).toBe(true);
      expect(replacement.modalEl.isConnected).toBe(true);
      replacement.onHistoryBack();
      expect(second.surface.isConnected).toBe(false);
      expect(replacement.modalEl.isConnected).toBe(true);
    },
  );

  it('dismisses newer and reopened sessions before the retained recurrence editor', async () => {
    const h = await fixture();
    const repeat = expectDefined(h.host.modalEl.querySelector<HTMLElement>('.abyss-repeat-chip'));
    repeat.click();
    const recurrence = expectDefined(h.host.modalEl.querySelector('.abyss-recurrence-popover'));
    const daily = expectDefined(
      recurrence.querySelector<HTMLButtonElement>('[data-recurrence-preset="daily"]'),
    );
    daily.click();
    for (let attempt = 0; attempt < 2; attempt++) {
      const { surface } = await openSurface(h.host, surfaces[0]);
      h.host.onHistoryBack();
      expect(surface.isConnected).toBe(false);
      expect(recurrence.isConnected).toBe(true);
      expect(
        recurrence.querySelector('[data-recurrence-preset="daily"]')?.getAttribute('aria-pressed'),
      ).toBe('true');
    }
    h.host.onHistoryBack();
    expect(recurrence.isConnected).toBe(false);
    expect(h.host.modalEl.isConnected).toBe(true);
    expect(document.activeElement).toBe(repeat);
    h.host.onHistoryBack();
    expect(h.host.modalEl.isConnected).toBe(false);
  });

  it('releases the recurrence owner when dependency search replaces its surface', async () => {
    const h = await fixture();
    expectDefined(h.host.modalEl.querySelector<HTMLElement>('.abyss-repeat-chip')).click();
    const recurrence = expectDefined(h.host.modalEl.querySelector('.abyss-recurrence-popover'));
    const { surface } = await openSurface(h.host, surfaces[1]);
    expect(recurrence.isConnected).toBe(false);
    h.host.onHistoryBack();
    expect(surface.isConnected).toBe(false);
    expect(h.host.modalEl.isConnected).toBe(true);
    h.host.onHistoryBack();
    expect(h.host.modalEl.isConnected).toBe(false);
  });

  it('does not let an invisible pending completion consume Back or revive after host replacement', async () => {
    const h = await fixture();
    const initial = await openSurface(h.host, surfaces[2]);
    h.host.onHistoryBack();
    expect(initial.surface.isConnected).toBe(false);
    const items = await new VaultFileSuggestionSource(h.app).links(
      'Al',
      new AbortController().signal,
      window,
    );
    const held = deferred<typeof items>();
    let signal: AbortSignal | undefined;
    vi.spyOn(VaultFileSuggestionSource.prototype, 'links').mockImplementationOnce(
      (_query, request) => {
        signal = request;
        return held.promise;
      },
    );
    h.comment.value = 'Draft [[Alp';
    h.comment.setSelectionRange(h.comment.value.length, h.comment.value.length);
    h.comment.dispatchEvent(new Event('input', { bubbles: true }));
    expect(signal?.aborted).toBe(false);

    h.host.onHistoryBack();

    expect(h.host.modalEl.isConnected).toBe(false);
    expect(signal?.aborted).toBe(true);
    h.modal.open(h.current);
    const replacement = expectDefined(h.opened.mock.instances[1]) as Modal;
    const latest = await openSurface(replacement, surfaces[2]);
    held.resolve(items);
    await flushMicrotasks();
    expect(document.querySelectorAll('.abyss-link-suggest')).toHaveLength(1);
    expect(latest.surface.isConnected).toBe(true);
    replacement.onHistoryBack();
    expect(latest.surface.isConnected).toBe(false);
    expect(replacement.modalEl.isConnected).toBe(true);
  });
});
