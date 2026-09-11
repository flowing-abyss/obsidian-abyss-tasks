import { Menu, type MenuItem } from 'obsidian';
import type {
  ProjectColumn,
  ProjectDateDisplay,
  ProjectFieldCatalogItem,
  ProjectPropertyType,
} from '../../projects/projectFields';
import { showMenuAtMouseEventWithFocus } from '../../ui/nativeMenuFocus';
import { configureNativeSubmenu } from '../../ui/nativeSubmenu';

const TYPE_ICONS: Readonly<Record<ProjectPropertyType, string>> = {
  text: 'text',
  list: 'list',
  number: 'binary',
  checkbox: 'check-square',
  date: 'calendar',
  datetime: 'calendar-clock',
  tags: 'tags',
};

const TYPE_LABELS: Readonly<Record<ProjectPropertyType, string>> = {
  text: 'Text',
  list: 'List',
  number: 'Number',
  checkbox: 'Checkbox',
  date: 'Date',
  datetime: 'Date & time',
  tags: 'Tags',
};

export interface ProjectColumnMenuOptions {
  readonly event: MouseEvent;
  readonly header: HTMLTableCellElement;
  readonly trigger: HTMLButtonElement;
  readonly column: ProjectColumn;
  readonly field: ProjectFieldCatalogItem;
  readonly sort: { readonly field: string; readonly dir: 'asc' | 'desc' };
  readonly beforeAction: (action: () => void) => void;
  readonly onSort: (direction: 'asc' | 'desc' | 'none') => void;
  readonly onAlignment: (alignment: 'left' | 'center' | 'right') => void;
  readonly onDateDisplay: (display: ProjectDateDisplay) => void;
  readonly typeChoices: readonly ProjectPropertyType[];
  readonly onType: (type: ProjectPropertyType) => void;
  readonly onRename: () => void;
  readonly restoreTableFocus: () => boolean;
}

interface ChoiceSubmenuOptions {
  readonly title: string;
  readonly icon: string;
  readonly owner: ProjectColumnMenuOptions;
  readonly configure: (submenu: Menu) => void;
  readonly restoreFocus: () => void;
}

function addChoiceSubmenu(menu: Menu, parent: MenuItem, options: ChoiceSubmenuOptions): void {
  parent.setTitle(options.title).setIcon(options.icon);
  configureNativeSubmenu(parent, {
    configure: options.configure,
    fallbackAnchor: options.owner.trigger,
    fallbackEvent: options.owner.event,
    parentMenu: menu,
    restoreFocus: options.restoreFocus,
  });
}

function run(options: ProjectColumnMenuOptions, action: () => void): void {
  options.beforeAction(action);
}

function addSortActions(menu: Menu, options: ProjectColumnMenuOptions): void {
  for (const [direction, title, icon] of [
    ['asc', 'Sort ascending', 'arrow-up'],
    ['desc', 'Sort descending', 'arrow-down'],
    ['none', 'Clear sorting', 'x'],
  ] as const) {
    const select = (): void => {
      options.onSort(direction);
    };
    menu.addItem((item) =>
      item
        .setTitle(title)
        .setIcon(icon)
        .setChecked(
          direction === 'none'
            ? options.sort.field === 'none'
            : options.sort.field === options.column.id && options.sort.dir === direction,
        )
        .onClick(() => {
          run(options, select);
        }),
    );
  }
}

function configureAlignment(submenu: Menu, options: ProjectColumnMenuOptions): void {
  for (const [alignment, title, icon] of [
    ['left', 'Left', 'align-left'],
    ['center', 'Center', 'align-center'],
    ['right', 'Right', 'align-right'],
  ] as const) {
    const select = (): void => {
      options.onAlignment(alignment);
    };
    submenu.addItem((choice) =>
      choice
        .setTitle(title)
        .setIcon(icon)
        .setChecked((options.column.alignment ?? 'left') === alignment)
        .onClick(() => {
          run(options, select);
        }),
    );
  }
}

function addAlignment(
  menu: Menu,
  options: ProjectColumnMenuOptions,
  restoreFocus: () => void,
): void {
  menu.addItem((item) => {
    addChoiceSubmenu(menu, item, {
      title: 'Alignment',
      icon: 'align-left',
      owner: options,
      restoreFocus,
      configure: (submenu) => {
        configureAlignment(submenu, options);
      },
    });
  });
}

function configureTypes(submenu: Menu, options: ProjectColumnMenuOptions): void {
  for (const type of options.typeChoices) {
    const select = (): void => {
      options.onType(type);
    };
    submenu.addItem((choice) =>
      choice
        .setTitle(TYPE_LABELS[type])
        .setIcon(TYPE_ICONS[type])
        .setChecked(options.field.type === type)
        .onClick(() => {
          run(options, select);
        }),
    );
  }
}

function addTypes(menu: Menu, options: ProjectColumnMenuOptions, restoreFocus: () => void): void {
  if (options.typeChoices.length <= 1) return;
  menu.addItem((item) => {
    addChoiceSubmenu(menu, item, {
      title: 'Property type',
      icon: 'settings-2',
      owner: options,
      restoreFocus,
      configure: (submenu) => {
        configureTypes(submenu, options);
      },
    });
  });
}

export interface ProjectDateDisplayMenuOptions {
  readonly active: ProjectDateDisplay;
  readonly onSelect: (display: ProjectDateDisplay) => void;
}

/** Adds shared project-date presentation choices to a native menu. */
export function configureProjectDateDisplayMenu(
  menu: Menu,
  options: ProjectDateDisplayMenuOptions,
): void {
  for (const [display, title, icon] of [
    ['pretty', 'Pretty', 'calendar-days'],
    ['raw', 'Raw', 'braces'],
    ['relative', 'Relative', 'clock'],
  ] as const) {
    menu.addItem((choice) =>
      choice
        .setTitle(title)
        .setIcon(icon)
        .setChecked(options.active === display)
        .onClick(() => {
          options.onSelect(display);
        }),
    );
  }
}

function configureColumnDateDisplayMenu(menu: Menu, options: ProjectColumnMenuOptions): void {
  configureProjectDateDisplayMenu(menu, {
    active: options.column.dateDisplay ?? 'pretty',
    onSelect: (display) => {
      run(options, () => {
        options.onDateDisplay(display);
      });
    },
  });
}

function addDateDisplay(
  menu: Menu,
  options: ProjectColumnMenuOptions,
  restoreFocus: () => void,
): void {
  if (options.field.type !== 'date' && options.field.type !== 'datetime') return;
  menu.addItem((item) => {
    addChoiceSubmenu(menu, item, {
      title: 'Date display',
      icon: 'calendar',
      owner: options,
      restoreFocus,
      configure: (submenu) => {
        configureColumnDateDisplayMenu(submenu, options);
      },
    });
  });
}

function priorTableFocus(
  options: ProjectColumnMenuOptions,
  previous: Element | null,
  tableRoot: HTMLElement | null,
): HTMLElement | undefined {
  const realm = options.header.ownerDocument.defaultView;
  if (realm === null || !(previous instanceof realm.HTMLElement) || !previous.isConnected) {
    return undefined;
  }
  return previous.classList.contains('abyss-project-table-cell') &&
    previous.closest('.abyss-projects-table') === tableRoot
    ? previous
    : undefined;
}

function currentColumnHeader(
  options: ProjectColumnMenuOptions,
  tableRoot: HTMLElement | null,
): HTMLElement | undefined {
  return Array.from(
    tableRoot?.querySelectorAll<HTMLElement>('.abyss-project-table-header-cell') ?? [],
  ).find((candidate) => candidate.dataset['columnId'] === options.column.id);
}

function restoreMenuFocus(
  options: ProjectColumnMenuOptions,
  previous: Element | null,
  tableRoot: HTMLElement | null,
): void {
  const active = options.header.ownerDocument.activeElement;
  if (active?.classList.contains('abyss-project-column-rename') === true) return;
  const prior = priorTableFocus(options, previous, tableRoot);
  if (prior !== undefined) {
    prior.focus({ preventScroll: true });
    return;
  }
  if (options.restoreTableFocus()) return;
  currentColumnHeader(options, tableRoot)
    ?.querySelector<HTMLElement>('button')
    ?.focus({ preventScroll: true });
}

export function showProjectColumnMenu(options: ProjectColumnMenuOptions): void {
  const previous = options.header.ownerDocument.activeElement;
  const tableRoot = options.header.closest<HTMLElement>('.abyss-projects-table');
  const restoreFocus = (): void => {
    restoreMenuFocus(options, previous, tableRoot);
  };
  const menu = new Menu();
  addSortActions(menu, options);
  menu.addSeparator();
  addAlignment(menu, options, restoreFocus);
  addTypes(menu, options, restoreFocus);
  addDateDisplay(menu, options, restoreFocus);
  menu.addSeparator();
  menu.addItem((item) =>
    item
      .setTitle('Rename column')
      .setIcon('pencil')
      .onClick(() => {
        run(options, options.onRename);
      }),
  );
  menu.onHide(restoreFocus);
  showMenuAtMouseEventWithFocus(menu, options.event);
}
