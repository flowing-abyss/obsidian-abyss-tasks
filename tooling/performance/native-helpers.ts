import { DEFAULT_SETTINGS } from '../../src/settings/defaults';
import { localDate } from '../../src/tasks';
import { projectCalendarOccurrences } from '../../src/views/calendarOccurrences';
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

const CALENDAR_DATES =
  '.abyss-mg-cell[data-mg-date], .abyss-tg-header-cell[data-tg-date], .abyss-tg-day-column[data-tg-date], .abyss-tg-allday-cell[data-tg-date], .abyss-calendar-date[data-calendar-date]';
const CALENDAR_CARDS =
  '.abyss-tg-body, .abyss-tg-block, .abyss-tg-deadline-marker, .abyss-mg-plain, .abyss-mg-block-dot, .abyss-mg-deadline-marker, .abyss-calendar-agenda .abyss-calendar-item';

function calendarDate(cell: HTMLElement): string {
  return cell.dataset['mgDate'] ?? cell.dataset['tgDate'] ?? cell.dataset['calendarDate'] ?? '';
}

function populatedCalendarCards(root: ParentNode, expectedPopulation: number): number {
  const cards = [...root.querySelectorAll<HTMLElement>(CALENDAR_CARDS)];
  if (
    (expectedPopulation > 0 && cards.length === 0) ||
    cards.some(
      (card) =>
        card.inert || card.getAttribute('aria-busy') === 'true' || card.textContent.trim() === '',
    )
  )
    throw new Error('Calendar has no complete populated task representation');
  return cards.length;
}

export function calendarEvidence(
  root: ParentNode,
  expectedPopulation: number,
): { dates: string[]; renderedCards: number; agendaDate: string | null } {
  const dates = [
    ...new Set([...root.querySelectorAll<HTMLElement>(CALENDAR_DATES)].map(calendarDate)),
  ].sort((left, right) => left.localeCompare(right));
  if (dates.length === 0 || dates.some((date) => !/^\d{4}-\d{2}-\d{2}$/u.test(date)))
    throw new Error('Calendar has no valid visible dates');
  dates.forEach(localDate);
  const renderedCards = populatedCalendarCards(root, expectedPopulation);
  const agenda = root.querySelector<HTMLElement>('.abyss-calendar-agenda[data-calendar-date]');
  const agendaDate = agenda?.dataset['calendarDate'] ?? null;
  if (root.querySelector('.abyss-calendar-date') !== null && agendaDate === null)
    throw new Error('Calendar selected agenda missing');
  if (agendaDate !== null && !dates.includes(agendaDate))
    throw new Error('Calendar agenda date is outside the visible range');
  return { dates, renderedCards, agendaDate };
}

/** Canonical occurrences identify the same work even when the view renders only one agenda. */
export function calendarPopulation(
  host: Host,
  dates: readonly string[],
): { occurrences: number; occurrencePopulation: string } {
  const from = dates[0];
  const to = dates[dates.length - 1];
  if (from === undefined || to === undefined) throw new Error('Calendar range missing');
  const projection = projectCalendarOccurrences(
    plugin(host).queries.forCalendarProjection(dates.map(localDate)),
    { from: localDate(from), to: localDate(to) },
    DEFAULT_SETTINGS.recurrence,
  );
  if (projection.issues.length > 0) throw new Error('Calendar occurrence projection is incomplete');
  return {
    occurrences: projection.occurrences.length,
    occurrencePopulation: JSON.stringify(
      projection.occurrences.map((occurrence) => [
        occurrence.key,
        occurrence.kind,
        occurrence.planning,
      ]),
    ),
  };
}

type CalendarSurface = Pick<DOMRect, 'x' | 'y' | 'width' | 'height'> &
  Pick<
    HTMLElement,
    | 'className'
    | 'clientWidth'
    | 'clientHeight'
    | 'scrollWidth'
    | 'scrollHeight'
    | 'scrollTop'
    | 'scrollLeft'
  >;

export function calendarDiagnostics(
  root: HTMLElement,
): ReturnType<typeof calendarEvidence> & { surfaces: CalendarSurface[]; html: string } {
  const surfaces = [
    root,
    ...root.querySelectorAll<HTMLElement>(
      '.abyss-cal-body, .abyss-tg-root, .abyss-tg-grid, .abyss-tg-grid-row, .abyss-mg-root, .abyss-calendar-agenda',
    ),
  ];
  return {
    ...calendarEvidence(root, 0),
    surfaces: surfaces.map((surface) => {
      const rect = surface.getBoundingClientRect();
      return {
        className: surface.className,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        clientWidth: surface.clientWidth,
        clientHeight: surface.clientHeight,
        scrollWidth: surface.scrollWidth,
        scrollHeight: surface.scrollHeight,
        scrollTop: surface.scrollTop,
        scrollLeft: surface.scrollLeft,
      };
    }),
    html: root.outerHTML,
  };
}
