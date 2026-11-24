import { frames, waitFor } from './native-helpers.ts';
import type { Measure } from './native-scenarios.ts';

export type ScrollView =
  | 'tasks.kanban'
  | 'tasks.timeline'
  | 'projects.table'
  | 'projects.kanban'
  | 'projects.timeline'
  | 'inspector.dependencies';

interface Surface {
  scroll: string;
  rows: string;
  label: string;
  headers?: string;
}

const regularOffsets = [2, 3, 4, 5, 6, 5, 4, 3, 2, 1];
const timelineOffsets = [2, 4, 7, 11, 18, 12, 9, 7, 5, 1];

const surfaces: Record<ScrollView, Surface> = {
  'tasks.kanban': {
    scroll: '.abyss-task-kanban-column-body',
    rows: '.abyss-virtual-row-frame',
    label: '.abyss-task-title',
  },
  'tasks.timeline': {
    scroll: '.abyss-task-timeline',
    rows: '.abyss-task-timeline-row',
    label: '.abyss-task-title',
    headers: '.abyss-project-timeline-axis',
  },
  'projects.table': {
    scroll: '.abyss-project-table-scroll',
    rows: '.abyss-project-table-row',
    label: '.abyss-project-table-name',
    headers: 'thead',
  },
  'projects.kanban': {
    scroll: '.abyss-project-kanban-column-body',
    rows: '.abyss-project-kanban-card',
    label: '.abyss-project-table-name',
  },
  'projects.timeline': {
    scroll: '.abyss-project-timeline-scroll',
    rows: '.abyss-project-timeline-row',
    label: '.abyss-project-table-name',
    headers: '.abyss-project-timeline-axis',
  },
  'inspector.dependencies': {
    scroll: '.abyss-dep-search-results',
    rows: '.abyss-dep-search-option',
    label: '.abyss-dep-search-title',
  },
};

export function uncoveredHeight(
  top: number,
  bottom: number,
  intervals: Array<[number, number]>,
): number {
  let cursor = top;
  let covered = 0;
  intervals.sort(([a], [b]) => a - b);
  for (const [start, end] of intervals) {
    const clipped = Math.min(bottom, end);
    covered += Math.max(0, clipped - Math.max(cursor, start));
    cursor = Math.max(cursor, clipped);
  }
  return bottom - top - covered;
}

function viewport(scroll: HTMLElement, surface: Surface): { top: number; bottom: number } {
  const top = scroll.getBoundingClientRect().top + scroll.clientTop;
  const header = surface.headers === undefined ? null : scroll.querySelector(surface.headers);
  return {
    top: Math.max(top, header?.getBoundingClientRect().bottom ?? top),
    bottom: top + scroll.clientHeight,
  };
}

interface ReadyRow {
  row: HTMLElement;
  label: HTMLElement;
}
export function readyRowLabel(row: HTMLElement, selector: string): HTMLElement | undefined {
  const label = row.querySelector<HTMLElement>(selector);
  if (
    label === null ||
    label.textContent.trim() === '' ||
    label.getBoundingClientRect().height <= 0
  )
    return;
  // Fetching the next range marks the dialog busy while mounted options still accept input.
  if (
    label.closest('[inert], [hidden], [aria-hidden="true"]') !== null ||
    row.contains(label.closest('[aria-busy="true"]'))
  )
    return;
  if (
    row.matches(
      '.abyss-dep-search-option:disabled, .abyss-dep-search-option[aria-disabled="true"]',
    ) &&
    (row.querySelector('.abyss-dep-search-reason')?.textContent.trim() ?? '') === ''
  )
    return;
  return label;
}
function visibleTimelinePreviews(scroll: HTMLElement, surface: Surface): ReadyRow[] {
  if (scroll.querySelector('.abyss-task-timeline-preview-row') === null) return [];
  const { top, bottom } = viewport(scroll, surface);
  const doc = scroll.ownerDocument;
  const x = scroll.getBoundingClientRect().left + Math.min(48, scroll.clientWidth / 2);
  const ready: ReadyRow[] = [];
  // Sample only the exposed summary column. A collection can have thousands of passive rows.
  for (let y = top + 1; y < bottom;) {
    const target = doc.elementFromPoint(x, y);
    const row = target?.closest<HTMLElement>(
      '.abyss-task-timeline-preview-row, .abyss-task-timeline-row, .abyss-group-header',
    );
    if (row === undefined || row === null || !scroll.contains(row)) {
      y += 8;
      continue;
    }
    const label = readyRowLabel(
      row,
      '.abyss-task-timeline-preview-title[data-timeline-preview-key]',
    );
    if (label !== undefined) ready.push({ row, label });
    y = Math.max(y + 1, row.getBoundingClientRect().bottom + 1);
  }
  return ready;
}

function readRows(
  scroll: HTMLElement,
  surface: Surface,
): { rows: HTMLElement[]; ready: ReadyRow[]; labels: ReadyRow[]; previews: ReadyRow[] } {
  const rows = [...scroll.querySelectorAll<HTMLElement>(surface.rows)];
  const labels = rows.flatMap((row) => {
    const label = readyRowLabel(row, surface.label);
    if (label === undefined) return [];
    return [{ row, label }];
  });
  if (surface !== surfaces['tasks.timeline']) return { rows, labels, ready: labels, previews: [] };
  const ready = labels.filter(({ label }) => {
    const card = label.closest<HTMLElement>('.abyss-task-card[data-row-key]');
    const status = card?.querySelector('.abyss-status-marker');
    return status !== undefined && status !== null && status.getBoundingClientRect().height > 0;
  });
  return { rows, labels, ready, previews: visibleTimelinePreviews(scroll, surface) };
}

function intervals(rows: HTMLElement[]): Array<[number, number]> {
  return rows.map((row) => {
    const rect = row.getBoundingClientRect();
    return [rect.top, rect.bottom];
  });
}

function identity({ row, label }: ReadyRow): string {
  return (
    row.dataset['projectPath'] ??
    label.closest<HTMLElement>('.abyss-task-card')?.dataset['rowKey'] ??
    label.textContent.trim()
  );
}

function hit(row: ReadyRow, scroll: HTMLElement, surface: Surface): HTMLElement | undefined {
  const { top, bottom } = viewport(scroll, surface);
  const rect = row.label.getBoundingClientRect();
  const x = Math.max(0, rect.left) + Math.min(rect.width / 2, 24);
  const start = Math.max(rect.top, top);
  const end = Math.min(rect.bottom, bottom);
  if (end <= start || x >= scroll.ownerDocument.documentElement.clientWidth) return;
  const y = (start + end) / 2;
  const target = scroll.ownerDocument.elementFromPoint(x, y);
  if (target !== null && target.instanceOf(HTMLElement) && row.label.contains(target)) {
    const control = target.closest('a, button, [role="button"], [role="link"]');
    if (control === null || control === row.label || !row.label.contains(control)) return target;
  }
  return undefined;
}

const nextFrame = (): Promise<number> =>
  new Promise((resolve) => window.requestAnimationFrame(resolve));
interface Step {
  offset: number;
  distance: number;
  inputDistance: number;
  frameMs: number;
  uncoveredPx: number;
  blankPx: number;
  visibleMetadataRows?: number;
  mounted: number;
  ready: number;
  surfaceMounted: number;
  previewReady: number;
}
export interface ScrollObservation {
  passes: Step[][];
  target: string;
  title: string;
  immediateHit: boolean;
  originalTargetHit: boolean;
  inputToHitMs: number;
  recoveryScrolls: number;
  clickToResultMs: number;
  viewportHeight: number;
}
export type RecordScroll = (view: ScrollView, observation: ScrollObservation) => void;

function sampleRows(
  scroll: HTMLElement,
  surface: Surface,
): Omit<Step, 'offset' | 'distance' | 'inputDistance' | 'frameMs'> {
  const timeline = surface === surfaces['tasks.timeline'];
  const { top, bottom } = viewport(scroll, surface);
  const { rows, ready, labels, previews } = readRows(scroll, surface);
  const groups = timeline ? [...scroll.querySelectorAll<HTMLElement>('.abyss-group-header')] : [];
  const groupIntervals = intervals(groups);
  const uncoveredPx = uncoveredHeight(top, bottom, [
    ...intervals(ready.map(({ row }) => row)),
    ...groupIntervals,
  ]);
  const blankPx = timeline
    ? uncoveredHeight(top, bottom, [
        ...intervals([...labels, ...previews].map(({ row }) => row)),
        ...groupIntervals,
      ])
    : uncoveredPx;
  const hasExposedMetadata = ({ row }: ReadyRow): boolean =>
    [
      ...row.querySelectorAll(
        '.abyss-task-tag, .abyss-task-date, .abyss-task-source-note, .abyss-task-time-part',
      ),
    ].some((node) => {
      const rect = node.getBoundingClientRect();
      return rect.height > 0 && rect.bottom > top && rect.top < bottom;
    });
  return {
    uncoveredPx,
    blankPx,
    mounted: rows.length,
    ready: ready.length,
    previewReady: previews.length,
    ...(timeline && { visibleMetadataRows: ready.filter(hasExposedMetadata).length }),
    surfaceMounted: (
      scroll.closest('.abyss-task-kanban, .abyss-project-kanban') ?? scroll
    ).querySelectorAll(surface.rows).length,
  };
}

async function traverse(scroll: HTMLElement, surface: Surface, step: number): Promise<Step[]> {
  const steps: Step[] = [];
  let previousFrame = await nextFrame();
  let previousOffset = scroll.scrollTop;
  const timeline = surface === surfaces['tasks.timeline'];
  const offsets = timeline ? timelineOffsets : regularOffsets;
  for (const offset of offsets) {
    let frame = timeline ? previousFrame : await nextFrame();
    const previous = scroll.scrollTop;
    scroll.scrollTop = offset * step;
    const offsetAfterInput = scroll.scrollTop;
    const distance = offsetAfterInput - previousOffset;
    previousOffset = offsetAfterInput;
    if (Math.abs(scroll.scrollTop - offset * step) > 1)
      throw new Error(`Scroll target outside ${surface.scroll}`);
    if (timeline) frame = await nextFrame();
    steps.push({
      offset: offsetAfterInput,
      distance,
      inputDistance: offsetAfterInput - previous,
      frameMs: frame - previousFrame,
      ...sampleRows(scroll, surface),
    });
    previousFrame = frame;
  }
  if (
    !steps.some((item) => item.distance >= step * 0.8) ||
    !steps.some((item) => item.distance <= -step * 0.8)
  )
    throw new Error(`No reversal in ${surface.scroll}`);
  return steps;
}

function reposition(
  scroll: HTMLElement,
  surface: Surface,
  row: ReadyRow | undefined,
  target: { step: number; optionPosition: number },
): void {
  const { step, optionPosition } = target;
  if (row === undefined) {
    const first = scroll.querySelector<HTMLElement>('[aria-posinset]');
    if (first === null || optionPosition < 1) scroll.scrollTop = step;
    else {
      const estimatedDistance =
        (optionPosition - Number(first.getAttribute('aria-posinset'))) *
        Math.max(1, first.getBoundingClientRect().height);
      scroll.scrollTop +=
        estimatedDistance +
        first.getBoundingClientRect().top -
        (viewport(scroll, surface).top + scroll.clientHeight / 2);
    }
  } else {
    const bounds = viewport(scroll, surface);
    const rect = row.label.getBoundingClientRect();
    scroll.scrollTop += (rect.top + rect.bottom - bounds.top - bounds.bottom) / 2;
  }
}

export function reversalStep(
  view: ScrollView,
  scroll: Pick<HTMLElement, 'clientHeight' | 'scrollHeight'>,
): number {
  const step = view === 'tasks.timeline' ? Math.min(scroll.clientHeight, 950) : 320;
  const offsets = view === 'tasks.timeline' ? timelineOffsets : regularOffsets;
  return Math.min(
    step,
    Math.floor((scroll.scrollHeight - scroll.clientHeight) / (Math.max(...offsets) + 1)),
  );
}

function currentHit(
  scroll: HTMLElement,
  surface: Surface,
  key?: string,
): (ReadyRow & { target: HTMLElement }) | undefined {
  for (const row of readRows(scroll, surface).ready) {
    if (key !== undefined && identity(row) !== key) continue;
    const target = hit(row, scroll, surface);
    if (target !== undefined) return { ...row, target };
  }
  return undefined;
}

export async function rapidScroll(
  view: ScrollView,
  measure: Measure,
  record: RecordScroll,
  verify: (key: string, title: string) => Promise<void>,
): Promise<void> {
  const surface = surfaces[view];
  const scroll = [...activeDocument.querySelectorAll<HTMLElement>(surface.scroll)].find(
    (node) =>
      node.clientHeight > 0 &&
      node.scrollHeight - node.clientHeight >= 250 &&
      node.getBoundingClientRect().left < innerWidth &&
      node.getBoundingClientRect().right > 0,
  );
  if (scroll === undefined) throw new Error(`Populated scroll surface missing: ${view}`);
  const step = reversalStep(view, scroll);
  scroll.scrollTop = step;
  await frames();
  const target = await waitFor(() => {
    const rows = readRows(scroll, surface).ready.filter(
      (row) =>
        !row.row.matches('[aria-disabled="true"], :disabled') &&
        hit(row, scroll, surface) !== undefined,
    );
    return rows[Math.min(1, rows.length - 1)];
  }, `visible hit-tested reference for ${view}`);
  const viewportHeight = scroll.clientHeight;
  const originalKey = identity(target);
  const optionPosition = Number(target.row.getAttribute('aria-posinset'));
  const passes: Step[][] = [];
  let observation: ScrollObservation | undefined;
  await measure(`ui.${view}.reversal`, async () => {
    passes.push(await traverse(scroll, surface, step));
    await frames();
    passes.push(await traverse(scroll, surface, step));
    const end = performance.now();
    const original = currentHit(scroll, surface, originalKey);
    let chosen = original;
    if (view === 'tasks.timeline' && chosen === undefined) {
      chosen = currentHit(scroll, surface);
      if (chosen === undefined)
        throw new Error('Immediate Timeline reversal target was not hit-testable');
    }
    const immediateHit = chosen !== undefined;
    let recoveryScrolls = 0;
    if (chosen === undefined) {
      await frames();
      chosen = await waitFor(() => {
        const current = currentHit(scroll, surface, originalKey);
        if (current !== undefined) return current;
        const row = readRows(scroll, surface).ready.find((item) => identity(item) === originalKey);
        reposition(scroll, surface, row, { step, optionPosition });
        recoveryScrolls++;
        return undefined;
      }, `reversal target ${originalKey}`);
    }
    const key = identity(chosen);
    const title = chosen.label.textContent.trim();
    const clickTime = performance.now();
    chosen.target.click();
    await verify(key, title);
    const result = performance.now();
    observation = {
      passes,
      target: key,
      title,
      immediateHit,
      originalTargetHit: original !== undefined,
      recoveryScrolls,
      inputToHitMs: clickTime - end,
      clickToResultMs: result - clickTime,
      viewportHeight,
    };
    return { target: key, passes: 2, steps: 20, opened: true };
  });
  if (observation !== undefined) record(view, observation);
}

export async function verifyTask(key: string, title: string): Promise<void> {
  await waitFor(() => {
    const card = [
      ...activeDocument.querySelectorAll<HTMLElement>('.abyss-center .abyss-task-card.is-selected'),
    ].find((node) => node.dataset['rowKey'] === key);
    const inspector = activeDocument.querySelector<HTMLElement>('.abyss-right-title-view');
    return (
      card !== undefined &&
      inspector !== null &&
      inspector.clientHeight > 0 &&
      inspector.textContent.trim() === title
    );
  }, `selected task key and visible inspector ${key}`);
}

export async function verifyProject(path: string, title: string): Promise<void> {
  await waitFor(() => {
    const header = activeDocument.querySelector<HTMLElement>('.abyss-project-dashboard-title');
    const cards = [
      ...activeDocument.querySelectorAll<HTMLElement>('.abyss-project-tasks .abyss-task-card'),
    ];
    return (
      header !== null &&
      header.clientHeight > 0 &&
      header.textContent === title &&
      cards.length > 0 &&
      cards.every((card) => card.dataset['rowKey']?.startsWith(`${path}:`) === true)
    );
  }, `selected project dashboard and task source ${path}`);
}
