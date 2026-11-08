import type { Component } from 'obsidian';
import type { ContentPlanV1, TaskTreeV1 } from '../../../api';
import type { CommandSessionSnapshot } from '../../ai/commandTypes';
import { durationMinutes, localDate, localTime, type TaskPlanning } from '../../tasks';
import { renderStatusMarker, updateStatusMarker } from '../StatusMarker';
import { runAsyncAction } from '../runAsyncAction';
import {
  mountTaskMetadataDisplay,
  type TaskMetadataDisplay,
  type TaskMetadataDisplayMount,
  type TaskMetadataDisplayOptions,
} from '../taskMetadataDisplay';
import type { CommandTreeOptions } from './CommandTree';
export interface CommandTaskBinding {
  readonly tree: TaskTreeV1;
  readonly plan?: ContentPlanV1;
  readonly removed: boolean;
}
interface Header {
  readonly marker: HTMLElement;
  readonly metadata: TaskMetadataDisplayMount;
  readonly removed: TaskMetadataDisplayMount;
}
function planning(tree: TaskTreeV1): TaskPlanning {
  return {
    ...(tree.dates.start === undefined ? {} : { start: localDate(tree.dates.start) }),
    ...(tree.dates.scheduled === undefined ? {} : { scheduled: localDate(tree.dates.scheduled) }),
    ...(tree.dates.due === undefined ? {} : { due: localDate(tree.dates.due) }),
    ...(tree.time === undefined ? {} : { time: localTime(tree.time) }),
    ...(tree.durationMinutes === undefined
      ? {}
      : { duration: durationMinutes(tree.durationMinutes) }),
  };
}
function changedMetadata(name: string, before: TaskTreeV1 | undefined, tree: TaskTreeV1): boolean {
  if (before === undefined) return false;
  const role = name.split(':')[0];
  if (role === 'time') return before.time !== tree.time;
  if (role === 'duration') return before.durationMinutes !== tree.durationMinutes;
  if (role === 'tag') return !before.tags.includes(name.slice(4));
  return (
    (role === 'start' || role === 'due' || role === 'scheduled') &&
    before.dates[role] !== tree.dates[role]
  );
}
function removedMetadata(
  binding: CommandTaskBinding,
  before: TaskTreeV1 | undefined,
): TaskMetadataDisplay {
  if (before === undefined || binding.plan === undefined) return { planning: {}, tags: [] };
  const current = planning(binding.tree);
  return {
    planning: Object.fromEntries(
      Object.entries(planning(before)).filter(([role]) => !(role in current)),
    ),
    tags: before.tags.filter((tag) => !binding.tree.tags.includes(tag)),
  };
}
export class CommandTreeHeader {
  private readonly headers = new WeakMap<HTMLElement, Header>();
  constructor(
    private readonly options: CommandTreeOptions,
    private readonly binding: (key: string) => CommandTaskBinding | undefined,
  ) {}
  render(
    host: HTMLElement,
    owner: Component,
    input: {
      readonly key: string;
      readonly before: TaskTreeV1 | undefined;
      readonly comparison: TaskTreeV1 | undefined;
      readonly state: CommandSessionSnapshot;
    },
  ): void {
    const binding = this.binding(input.key);
    if (binding === undefined) return;
    this.selection(host, binding.tree.target, input.state);
    const pending = input.state.proposal.changes.find(
      (change) => change.kind === 'status' && change.target === binding.tree.target,
    );
    const task = {
      statusSymbol: pending?.kind === 'status' ? pending.symbol : binding.tree.statusSymbol,
      priority: binding.tree.priority,
    };
    const metadataOptions = this.metadataOptions(owner);
    const value = {
      planning: planning(binding.tree),
      tags: binding.tree.tags,
      ...(binding.tree.source === undefined ? {} : { sourcePath: binding.tree.source.path }),
    };
    let header = this.headers.get(host);
    if (header === undefined) {
      const marker = renderStatusMarker(host, {
        task,
        registry: this.options.registry,
        interactive: true,
        onLeftClick: () => {
          this.status(input.key);
        },
        onContextMenu: () => {},
      });
      host.prepend(marker.closest<HTMLElement>('.abyss-status-control') ?? marker);
      header = {
        marker,
        metadata: mountTaskMetadataDisplay(host, value, metadataOptions),
        removed: mountTaskMetadataDisplay(host, { planning: {}, tags: [] }, metadataOptions),
      };
      header.metadata.host.append(header.removed.host);
      this.headers.set(host, header);
    } else {
      updateStatusMarker(header.marker, { task, registry: this.options.registry });
      header.metadata.update(value, metadataOptions);
    }
    header.removed.update(removedMetadata(binding, input.before), metadataOptions);
    header.metadata.host.hidden = ![header.metadata.host, header.removed.host].some(
      (element) => element.hidden === false,
    );
    header.removed.host.inert = true;
    header.marker.dataset['change'] =
      pending !== undefined ||
      (input.comparison !== undefined && input.comparison.statusSymbol !== task.statusSymbol)
        ? 'changed'
        : '';
    this.markChanges(header, input.comparison, binding.tree);
  }
  private markChanges(header: Header, comparison: TaskTreeV1 | undefined, tree: TaskTreeV1): void {
    for (const element of header.removed.values.values()) element.dataset['change'] = 'removed';
    for (const [name, element] of header.metadata.values)
      element.dataset['change'] = changedMetadata(name, comparison, tree) ? 'changed' : '';
  }
  private selection(host: HTMLElement, target: string, state: CommandSessionSnapshot): void {
    const selected = state.focus.some((focus) => focus.kind === 'task' && focus.target === target);
    host.classList.toggle('is-selected', selected);
    if (selected) host.setAttribute('aria-current', 'true');
    else host.removeAttribute('aria-current');
  }
  private metadataOptions(owner: Component): TaskMetadataDisplayOptions {
    return {
      owner,
      suppressToday: false,
      completePlanning: true,
      formatDate: this.options.formatDate ?? ((date) => date),
      getDateClass: this.options.getDateClass ?? (() => ''),
      getTagColor: this.options.getTagColor ?? (() => undefined),
      showSource: this.options.showSource ?? (() => true),
    };
  }
  private currentStatus(tree: TaskTreeV1): TaskTreeV1['status'] {
    const pending = this.options.owner
      .snapshot()
      .proposal.changes.find((change) => change.kind === 'status' && change.target === tree.target);
    return pending?.kind === 'status'
      ? this.options.registry.typeForSymbol(pending.symbol)
      : tree.status;
  }
  private status(key: string): void {
    const binding = this.binding(key);
    if (binding === undefined || binding.removed || !this.options.isCurrent()) return;
    const symbol =
      this.currentStatus(binding.tree) === 'done'
        ? this.options.registry.defaultTodo().symbol
        : this.options.registry.defaultDone().symbol;
    const input = { target: binding.tree.target, revision: binding.tree.revision, symbol };
    const work =
      binding.plan === undefined
        ? this.options.owner.applyStatus(input)
        : this.options.owner.stageStatus({
            ...input,
            plan: binding.plan.target,
            expectedPlanRevision: binding.plan.revision,
          });
    runAsyncAction(work, 'Could not change task status');
  }
}
