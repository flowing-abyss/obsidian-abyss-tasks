import type { NoteReadPageV1 } from '../../api';
import type { NoteRange, NoteSelection } from '../notes/noteApi';
import type { NoteReadRegistry } from './NoteReadRegistry';

export function noteBoundary(text: string, to: number): number {
  if (to <= 0 || to >= text.length) return to;
  const previous = text[to - 1] ?? '',
    next = text[to] ?? '';
  if (previous === '\r' && next === '\n') return to - 1;
  if (/[\uD800-\uDBFF]/u.test(previous) && /[\uDC00-\uDFFF]/u.test(next)) return to - 1;
  return to;
}
interface PageState {
  position: number;
  remaining: number;
  readonly sections: number;
  readonly segments: Array<NoteReadPageV1['segments'][number]>;
}
function segment(
  registry: NoteReadRegistry,
  selected: NoteSelection,
  range: NoteRange,
  state: PageState,
): void {
  const source = selected.source;
  const start = Math.max(state.position, range.from, selected.range.from);
  const end = noteBoundary(
    source.content,
    Math.min(range.to, selected.range.to, start + state.remaining),
  );
  const clipped = range.from < selected.range.from || range.to > selected.range.to;
  const section = registry.section(source, clipped ? { ...range, editable: false } : range);
  state.segments.push({
    section,
    text: source.content.slice(start, end),
    continuesPrevious: start > range.from,
    continuesNext: end < range.to,
  });
  state.remaining -= end - start;
  state.position = end;
}
function precedes(range: NoteRange, position: number): boolean {
  return range.to < position || (range.to === position && range.from !== range.to);
}
export function noteSegments(
  registry: NoteReadRegistry,
  selected: NoteSelection,
  limits: { position: number; characters: number; sections: number },
): { segments: NoteReadPageV1['segments']; position: number; complete: boolean } {
  const state: PageState = {
    position: selected.range.from + limits.position,
    remaining: limits.characters,
    sections: limits.sections,
    segments: [],
  };
  let exhausted = true;
  for (const range of registry.port.sections(selected.source)) {
    if (
      precedes(range, state.position) ||
      (range.from >= selected.range.to && range.to > selected.range.to)
    )
      continue;
    if (
      (state.remaining < 2 && range.from !== range.to) ||
      state.segments.length >= state.sections
    ) {
      exhausted = false;
      break;
    }
    segment(registry, selected, range, state);
    if (state.position < Math.min(range.to, selected.range.to)) {
      exhausted = false;
      break;
    }
  }
  return {
    segments: state.segments,
    position: state.position - selected.range.from,
    complete: exhausted && state.position >= selected.range.to,
  };
}
