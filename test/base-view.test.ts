import { describe, expect, it } from 'vitest';
import type { ResolvedConfig } from '../src/settings/types';
import type { TaskSnapshot as Task } from '../src/tasks';
import { BaseView } from '../src/views/BaseView';
import { freshContainer, resolvedConfig, task, useRealMoment } from './helpers';

useRealMoment();

type RenderArgs = { container: HTMLElement; tasks: Task[]; config: ResolvedConfig };

class TestView extends BaseView {
  renderCalls = 0;
  patchCalls = 0;
  destroyed = false;
  lastArgs: RenderArgs | null = null;

  render(container: HTMLElement, tasks: Task[], config: ResolvedConfig): void {
    this.renderCalls++;
    this.lastArgs = { container, tasks, config };
  }
  override patch(container: HTMLElement, tasks: Task[], config: ResolvedConfig): void {
    this.patchCalls++;
    this.lastArgs = { container, tasks, config };
  }
  override destroy(): void {
    this.destroyed = true;
  }
}

describe('BaseView', () => {
  it('render receives (container, tasks, config)', () => {
    const v = new TestView();
    const container = freshContainer();
    const tasks = [task()];
    const config = resolvedConfig();
    v.render(container, tasks, config);
    expect(v.renderCalls).toBe(1);
    expect(v.lastArgs?.container).toBe(container);
    expect(v.lastArgs?.tasks).toBe(tasks);
    expect(v.lastArgs?.config).toBe(config);
  });

  it('default patch delegates to render (same args)', () => {
    class DefaultPatch extends BaseView {
      renderCalls = 0;
      render(c: HTMLElement, _t: Task[], _cfg: ResolvedConfig): void {
        this.renderCalls++;
        c.createDiv({ text: 'rendered' });
      }
      destroy(): void {}
    }
    const v = new DefaultPatch();
    const container = freshContainer();
    v.patch(container, [task()], resolvedConfig());
    expect(v.renderCalls).toBe(1);
    expect(container.textContent).toBe('rendered');
  });

  it('override patch is invoked instead of render', () => {
    class OverridePatch extends BaseView {
      renderCalls = 0;
      patchCalls = 0;
      render(): void {
        this.renderCalls++;
      }
      override patch(c: HTMLElement, _t: Task[], _cfg: ResolvedConfig): void {
        this.patchCalls++;
        c.createDiv({ text: 'patched' });
      }
      destroy(): void {}
    }
    const v = new OverridePatch();
    const container = freshContainer();
    v.patch(container, [task()], resolvedConfig());
    expect(v.patchCalls).toBe(1);
    expect(v.renderCalls).toBe(0);
    expect(container.textContent).toBe('patched');
  });

  it('destroy is callable and clears subclass state', () => {
    const v = new TestView();
    v.destroy();
    expect(v.destroyed).toBe(true);
  });
});
