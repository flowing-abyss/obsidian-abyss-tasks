import { Menu, setIcon } from 'obsidian';
import type { Project } from '../../projects/types';
import { showMenuAtMouseEventWithFocus } from '../../ui/nativeMenuFocus';
import { renderProgressBar } from './progressBar';
import type { ProjectsDashboardContext } from './viewContext';

/** Detail view for a single project: header, stats, description, its tasks. */
export function renderProjectDashboard(
  container: HTMLElement,
  project: Project | undefined,
  ctx: ProjectsDashboardContext,
): void {
  container.addClass('abyss-projects-dashboard');

  const back = container.createEl('button', { cls: 'abyss-project-back' });
  setIcon(back, 'arrow-left');
  back.createSpan({ text: 'Back to projects' });
  back.addEventListener('click', () => ctx.state.set('projectsPanel', { view: 'list' }));

  if (!project) {
    container.createDiv({ cls: 'abyss-projects-empty', text: 'Project not found' });
    return;
  }

  const statuses = ctx.settings.projects.statuses;
  const status = project.statusId ? statuses.find((s) => s.id === project.statusId) : undefined;

  const header = container.createDiv({ cls: 'abyss-project-dashboard-header' });
  header.createEl('h2', { cls: 'abyss-project-dashboard-title', text: project.name });

  const pill = header.createEl('button', { cls: 'abyss-status-pill' });
  if (status?.color) pill.style.background = status.color;
  pill.setText(status?.label ?? project.rawStatus ?? 'No status');
  pill.addEventListener('click', (e) => {
    const menu = new Menu();
    for (const s of statuses) {
      menu.addItem((item) =>
        item
          .setTitle(s.label)
          .setChecked(s.id === project.statusId)
          .onClick(() => ctx.onSetStatus(project.path, s.id)),
      );
    }
    showMenuAtMouseEventWithFocus(menu, e);
  });

  const open = header.createEl('button', {
    cls: 'abyss-project-open-btn',
    attr: { 'aria-label': 'Open note' },
  });
  setIcon(open, 'file-text');
  open.addEventListener('click', () => ctx.openNote(project.path));

  const stats = container.createDiv({ cls: 'abyss-project-dashboard-stats' });
  renderProgressBar(stats, project.stats.done, project.stats.total);

  const rawDesc = project.frontmatter['description'];
  const desc = typeof rawDesc === 'string' ? rawDesc.trim() : '';
  if (desc) {
    container.createDiv({ cls: 'abyss-project-description', text: desc });
  }

  const taskHost = container.createDiv({ cls: 'abyss-project-tasks' });
  ctx.renderTasks(taskHost, project.path);
}
