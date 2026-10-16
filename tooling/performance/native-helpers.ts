import type { Host, ProfilePlugin } from './native-types.ts';
import { bounded } from './profiler.ts';

export function assertViewport(expected: string): void {
  const actual = `${window.innerWidth}x${window.innerHeight}`;
  if (actual !== expected)
    throw new Error(`Viewport changed: expected ${expected}, received ${actual}`);
}

export function plugin(host: Host): ProfilePlugin {
  const value = host.plugins.plugins['abyss-tasks'];
  if (value === undefined) throw new Error('Abyss Tasks is not loaded');
  return value;
}

export async function waitFor<T>(
  read: () => T | undefined | null | false | Promise<T | undefined | null | false>,
  label: string,
  timeout = 15000,
): Promise<T> {
  const end = performance.now() + timeout;
  for (;;) {
    const value = await read();
    if (value !== undefined && value !== null && value !== false) return value;
    if (performance.now() > end) throw new Error(`Readiness timed out: ${label}`);
    await new Promise((resolve) => {
      window.setTimeout(resolve, 10);
    });
  }
}

export async function frames(): Promise<void> {
  await bounded(
    new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          resolve();
        });
      });
    }),
    5000,
    'foreground paint opportunity',
  );
}

export function element<T extends HTMLElement = HTMLElement>(selector: string): T {
  const value = document.querySelector<T>(selector);
  if (value === null) throw new Error(`UI element missing: ${selector}`);
  return value;
}

export async function click(selector: string): Promise<void> {
  element(selector).click();
  await frames();
}

function readyRange(scroller: HTMLElement): string | undefined {
  const cards = [...scroller.querySelectorAll<HTMLElement>('.abyss-task-card')];
  if (
    cards.length === 0 ||
    cards.some(
      (card) =>
        card.inert || card.getAttribute('aria-busy') === 'true' || card.textContent.trim() === '',
    )
  )
    return undefined;
  return cards.map((card) => card.textContent).join('\n');
}

export async function scrollRange(scroller: HTMLElement, fraction: number): Promise<void> {
  const previous = readyRange(scroller);
  scroller.scrollTop = fraction * (scroller.scrollHeight - scroller.clientHeight);
  scroller.dispatchEvent(new Event('scroll'));
  await frames();
  const applied = await waitFor(() => {
    const current = readyRange(scroller);
    return current !== previous ? current : undefined;
  }, 'new hydrated scroll range');
  await frames();
  await waitFor(() => readyRange(scroller) === applied, 'stable scroll range');
}

export async function indexed(host: Host): Promise<void> {
  // This is the concrete TaskIndex behind the existing public query port. Keep the
  // tooling adapter explicit; no product API or private mangled name is introduced.
  const queries = plugin(host).queries as ProfilePlugin['queries'] & {
    initialize?: () => Promise<void>;
  };
  if (queries.initialize === undefined)
    throw new Error('TaskIndex readiness adapter is unavailable');
  await bounded(queries.initialize(), 30000, 'task index initialized');
}

export function assertRoots(host: Host, expected = 4000): void {
  const count = plugin(host).queries.list().length;
  if (count !== expected) throw new Error(`Fixture roots: expected ${expected}, received ${count}`);
}

export async function closePanels(host: Host): Promise<void> {
  for (const leaf of host.workspace.getLeavesOfType('task-calendar-panel')) leaf.detach();
  await frames();
}
