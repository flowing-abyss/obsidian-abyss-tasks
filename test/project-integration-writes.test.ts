import { TFile } from 'obsidian';
import { afterEach, expect, it, vi } from 'vitest';
import { NoteTemplateService } from '../src/notes/NoteTemplateService';
import { ProjectManager } from '../src/projects/ProjectManager';
import { createProjectIntegrationReads } from '../src/projects/projectIntegration';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { expectDefined, useRealMoment } from './helpers';
import { publicApiHarness } from './support/publicApiHarness';

useRealMoment();
afterEach(() => vi.restoreAllMocks());
const path = 'P.md';
const original = '---\nstatus: Old\nkeep: other\n---\n#project\n';
async function harness(files: Record<string, string> = { [path]: original }) {
  const h = await publicApiHarness(files, {
    index: {
      excludeSource: (source) => source.tags.includes('#private'),
    },
  });
  const settings = structuredClone(DEFAULT_SETTINGS);
  const projects = settings.projects;
  Object.assign(projects, {
    membershipQuery: '#project',
    statusProperty: 'status',
    startProperty: 'start',
    endProperty: 'end',
    statuses: [{ id: 'active', name: 'Active', onLeftPanel: true }],
    defaultStatusId: 'active',
    createFolder: 'Projects',
    taskInsertionSection: '## Tasks',
    propertyDefinitionsVersion: 1,
    propertyDefinitions: {
      'property:Budget': { type: 'number' },
      'property:tags': { type: 'tags' },
    },
  });
  const sources = h.index.projectSources();
  const reads = createProjectIntegrationReads(sources, () => projects);
  const manager = new ProjectManager(h.app, settings, new NoteTemplateService(h.app), h.service);
  const writes = manager.integrationWrites(reads, sources);
  function proof() {
    const result = reads.summary(path);
    if (result.type !== 'ok') throw new Error(result.reason);
    return expectDefined(result.value);
  }
  return { ...h, projects, reads, writes, proof };
}
const budget = { fieldId: 'property:budget', value: 0 };
it('updates status and fields together, retaining spelling, zero, unrelated keys and body', async () => {
  const h = await harness();
  try {
    const result = await h.writes.update(h.proof(), { statusId: 'active', fields: [budget] });
    expect(result).toMatchObject({ outcome: 'changed', effects: 'committed', project: { path } });
    expect(await h.read(path)).toBe('---\nstatus: Active\nkeep: other\nBudget: 0\n---\n#project\n');
    expect(h.reads.get(path)).toMatchObject({
      value: { status: { state: 'configured', id: 'active' } },
    });
  } finally {
    h.dispose();
  }
});
it('preserves exact source bytes for a guarded absent clear without YAML', async () => {
  const h = await harness({ [path]: '#project\r\n' });
  try {
    expect(
      await h.writes.update(h.proof(), { statusId: null, fields: [{ ...budget, value: null }] }),
    ).toMatchObject({ outcome: 'noop', effects: 'unchanged' });
    expect(await h.read(path)).toBe('#project\r\n');
  } finally {
    h.dispose();
  }
});
it.each([
  [
    'inverted dates',
    original,
    [
      { fieldId: 'start', value: '2027-01-01' },
      { fieldId: 'end', value: '2026-01-01' },
    ],
  ],
  ['authored null', original.replace('keep: other', 'budget: null'), [budget]],
  ['ambiguous spelling', original.replace('keep: other', 'budget: 1\nBudget: 2'), [budget]],
  ['wrong assignment', original, [{ ...budget, value: false }]],
  ['duplicate physical cell', original, [budget, { ...budget, fieldId: 'property:Budget' }]],
  ['ambiguous status', original.replace('status: Old', 'status: [Old]'), [budget]],
  ['private candidate', original, [{ fieldId: 'property:tags', value: ['private'] }]],
  [
    'lost membership',
    original.replace('keep: other', 'tags: [project]').replace('#project', 'body'),
    [{ fieldId: 'property:tags', value: null }],
  ],
] as const)('rejects %s before changing any metadata', async (_label, content, fields) => {
  const h = await harness({ [path]: content });
  try {
    expect(await h.writes.update(h.proof(), { statusId: 'active', fields })).toMatchObject({
      outcome: 'failed',
      effects: 'unchanged',
    });
    expect(await h.read(path)).toBe(content);
  } finally {
    h.dispose();
  }
});
it.each(['status rename', 'binding', 'replacement', 'live YAML', 'definitions version'])(
  'rechecks %s at Vault.process',
  async (race) => {
    const h = await harness();
    try {
      const vault = h.app.vault,
        process = vault.process.bind(vault);
      vi.spyOn(vault, 'process').mockImplementationOnce(async (file, transform) => {
        if (race === 'status rename') expectDefined(h.projects.statuses[0]).name = 'Changed';
        if (race === 'binding') h.projects.statusProperty = 'renamed';
        if (race === 'definitions version') h.projects.propertyDefinitionsVersion = 99;
        if (race === 'live YAML') await vault.modify(file, '---\nkey: [\n---\n#project');
        if (race === 'replacement') {
          await vault.rename(file, 'old.md');
          await vault.create(path, original);
        }
        return process(file, transform);
      });
      expect(
        await h.writes.update(h.proof(), { statusId: 'active', fields: [budget] }),
      ).toMatchObject({ outcome: 'failed', effects: 'unchanged' });
      expect(await h.read(path)).not.toContain('Budget: 0');
    } finally {
      h.dispose();
    }
  },
);
it('creates final permitted template bytes and reconciles the actual suffixed file', async () => {
  const h = await harness({ 'templates/p.md': '# {{title}} {{date}}\n', 'Projects/A.md': 'keep' });
  try {
    h.projects.templatePath = 'templates/p.md';
    expect(
      await h.writes.create({
        name: 'A',
        fields: [budget, { fieldId: 'property:tags', value: ['project'] }],
      }),
    ).toMatchObject({
      outcome: 'changed',
      effects: 'committed',
      project: { path: 'Projects/A 2.md' },
    });
    expect(await h.read('Projects/A 2.md')).toMatch(/Budget: 0[\s\S]*# A \d{4}-\d{2}-\d{2}/u);
    expect(await h.read('Projects/A.md')).toBe('keep');
  } finally {
    h.dispose();
  }
});
it.each(['private', 'executable', 'nonmember', 'malformed'])(
  'rejects a %s creation before folder provisioning',
  async (kind) => {
    const body =
      {
        private: '#private #project',
        executable: '<% command %> #project',
        nonmember: 'other',
        malformed: '---\nkey: [\n---\n#project',
      }[kind] ?? '';
    const h = await harness({ 'template.md': body });
    try {
      h.projects.templatePath = 'template.md';
      expect(await h.writes.create({ name: 'New' })).toMatchObject({
        outcome: 'failed',
        effects: 'unchanged',
      });
      expect(h.app.vault.getAbstractFileByPath('Projects')).toBeNull();
    } finally {
      h.dispose();
    }
  },
);
it.each(['replaced', 'edited', 'excluded', 'config', 'collision'])(
  'checks %s template or destination after provisioning',
  async (race) => {
    const h = await harness({ 'template.md': '#project' });
    try {
      h.projects.templatePath = 'template.md';
      const vault = h.app.vault,
        make = vault.createFolder.bind(vault);
      vi.spyOn(vault, 'createFolder').mockImplementationOnce(async (folder) => {
        const result = await make(folder);
        const template = vault.getFileByPath('template.md');
        if (!(template instanceof TFile)) throw new Error('Missing template');
        if (race === 'replaced') {
          await vault.rename(template, 'old.md');
          await vault.create('template.md', '#project');
        }
        if (race === 'edited') await vault.modify(template, '#project edit');
        if (race === 'excluded') await h.external('template.md', '#private #project');
        if (race === 'config') Object.assign(h.projects, { createFolder: 'Other' });
        if (race === 'collision') await vault.create('Projects/New.md', 'other');
        return result;
      });
      expect(await h.writes.create({ name: 'New' })).toMatchObject({
        outcome: 'failed',
        effects: 'partial',
      });
      if (race === 'collision') expect(await h.read('Projects/New.md')).toBe('other');
      else expect(vault.getFileByPath('Projects/New.md')).toBeNull();
    } finally {
      h.dispose();
    }
  },
);

it('honors default, fallback and explicit null while preserving literal titles', async () => {
  const h = await harness({ 'template.md': '---\nstatus: FromTemplate\n---\n#project {{title}}' });
  try {
    h.projects.templatePath = 'template.md';
    h.projects.statuses.push({ id: 'later', name: 'Later', onLeftPanel: true });
    h.projects.defaultStatusId = 'later';
    expect(await h.writes.create({ name: 'Default' })).toMatchObject({
      project: { status: { state: 'configured', id: 'later' } },
    });
    h.projects.defaultStatusId = '';
    expect(await h.writes.create({ name: 'Fallback' })).toMatchObject({
      project: { status: { state: 'configured', id: 'active' } },
    });
    expect(await h.writes.create({ name: 'Budget $&', statusId: null })).toMatchObject({
      project: { status: { state: 'absent' } },
    });
    expect(await h.read('Projects/Budget $&.md')).toContain('#project Budget $&');
  } finally {
    h.dispose();
  }
});
it('keeps an unobserved template edit from provisioning folders', async () => {
  const h = await harness({ 'template.md': '#project' });
  try {
    h.projects.templatePath = 'template.md';
    const vault = h.app.vault,
      read = vault.read.bind(vault);
    vi.spyOn(vault, 'read').mockImplementation((file) =>
      file.path === 'template.md' ? Promise.resolve('#private') : read(file),
    );
    expect(await h.writes.create({ name: 'New' })).toMatchObject({
      outcome: 'failed',
      effects: 'unchanged',
    });
    expect(h.app.vault.getAbstractFileByPath('Projects')).toBeNull();
  } finally {
    h.dispose();
  }
});
it('preserves a real false and validates the combined dates after both assignments', async () => {
  const h = await harness({ [path]: '---\nstart: 2026-01-01\nend: 2026-02-01\n---\n#project' });
  try {
    h.projects.propertyDefinitions['property:Flag'] = { type: 'checkbox' };
    const result = await h.writes.update(h.proof(), {
      fields: [
        { fieldId: 'start', value: '2026-03-01' },
        { fieldId: 'end', value: '2026-04-01' },
        { fieldId: 'property:flag', value: false },
      ],
    });
    expect(result).toMatchObject({ effects: 'committed' });
    expect(await h.read(path)).toContain('Flag: false');
  } finally {
    h.dispose();
  }
});
it.each(['before', 'after', 'replaced'])(
  'accounts for a lost update acknowledgement %s storage',
  async (when) => {
    const h = await harness();
    try {
      const vault = h.app.vault,
        process = vault.process.bind(vault);
      vi.spyOn(vault, 'process').mockImplementationOnce(async (file, transform) => {
        if (when === 'before') transform(await vault.read(file));
        else await process(file, transform);
        if (when === 'replaced') {
          await vault.rename(file, 'old.md');
          await vault.create(path, original);
        }
        throw new Error('host failure');
      });
      expect(await h.writes.update(h.proof(), { statusId: 'active' })).toMatchObject({
        outcome: 'failed',
        effects: { before: 'unchanged', after: 'committed', replaced: 'unknown' }[when],
      });
    } finally {
      h.dispose();
    }
  },
);
it('omits the reference when a host replaces the created note with identical bytes', async () => {
  const h = await harness();
  try {
    h.projects.createFolder = '';
    h.projects.taskInsertionSection = '#project';
    const vault = h.app.vault,
      create = vault.create.bind(vault);
    vi.spyOn(vault, 'create').mockImplementationOnce(async (dest, content) => {
      const file = await create(dest, content);
      await vault.rename(file, 'moved.md');
      await create(dest, content);
      return file;
    });
    const result = await h.writes.create({ name: 'New' });
    expect(result).toEqual({ outcome: 'failed', effects: 'committed', reason: 'unavailable' });
  } finally {
    h.dispose();
  }
});
it('treats a created path without a returned file as an unknown acknowledgement', async () => {
  const h = await harness();
  try {
    h.projects.createFolder = '';
    h.projects.taskInsertionSection = '#project';
    const vault = h.app.vault,
      create = vault.create.bind(vault);
    vi.spyOn(vault, 'create').mockImplementationOnce(async (dest, content) => {
      await create(dest, content);
      throw new Error('lost');
    });
    expect(await h.writes.create({ name: 'New' })).toEqual({
      outcome: 'failed',
      effects: 'unknown',
      reason: 'io',
    });
  } finally {
    h.dispose();
  }
});
it('retains the owned note when Templater suppression cleanup fails without rendering', async () => {
  const h = await harness();
  try {
    h.projects.taskInsertionSection = '#project';
    const starts: string[] = [];
    Object.defineProperty(h.app, 'plugins', {
      configurable: true,
      value: {
        getPlugin: () => ({
          templater: {
            files_with_pending_templates: new Set<string>(),
            start_templater_task: (dest: string) => starts.push(dest),
            end_templater_task: () => Promise.reject(new Error('cleanup')),
            create_running_config: () => {
              throw new Error('unexpected render');
            },
            read_and_parse_template: () => {
              throw new Error('unexpected render');
            },
          },
        }),
      },
    });
    expect(await h.writes.create({ name: 'Safe' })).toMatchObject({
      outcome: 'failed',
      effects: 'committed',
      project: { path: 'Projects/Safe.md' },
    });
    expect(starts).toEqual(['Projects/Safe.md']);
    expect(await h.read('Projects/Safe.md')).toContain('#project');
  } finally {
    h.dispose();
  }
});

it('does not infer an unchanged workspace from an absent path after a lost creation acknowledgement', async () => {
  const h = await harness();
  try {
    h.projects.createFolder = '';
    h.projects.taskInsertionSection = '#project';
    const vault = h.app.vault,
      create = vault.create.bind(vault);
    vi.spyOn(vault, 'create').mockImplementationOnce(async (dest, content) => {
      const owned = await create(dest, content);
      await vault.rename(owned, 'Moved.md');
      throw new Error('no ack');
    });
    expect(await h.writes.create({ name: 'New' })).toEqual({
      outcome: 'failed',
      effects: 'unknown',
      reason: 'io',
    });
    expect(await h.read('Moved.md')).toContain('#project');
  } finally {
    h.dispose();
  }
});
it('omits a replaced project after a no-op transform', async () => {
  const h = await harness();
  try {
    const vault = h.app.vault,
      process = vault.process.bind(vault);
    vi.spyOn(vault, 'process').mockImplementationOnce(async (file, transform) => {
      const content = await process(file, transform);
      await vault.rename(file, 'Moved.md');
      await vault.create(path, original);
      return content;
    });
    expect(await h.writes.update(h.proof(), { fields: [{ ...budget, value: null }] })).toEqual({
      outcome: 'noop',
      effects: 'unchanged',
    });
  } finally {
    h.dispose();
  }
});

it.each(['scope', 'default'])(
  'rejects a changed %s after folder setup even when the original candidate is permitted',
  async (race) => {
    const h = await harness();
    try {
      h.projects.taskInsertionSection = '#project';
      h.projects.defaultStatusId = '';
      const vault = h.app.vault,
        make = vault.createFolder.bind(vault);
      vi.spyOn(vault, 'createFolder').mockImplementationOnce(async (path) => {
        const result = await make(path);
        if (race === 'scope') await h.index.refreshSourceExclusion(() => false);
        else Object.assign(h.projects, { defaultStatusId: 'missing' });
        return result;
      });
      expect(await h.writes.create({ name: 'New' })).toMatchObject({
        outcome: 'failed',
        effects: 'partial',
      });
      expect(vault.getFileByPath('Projects/New.md')).toBeNull();
    } finally {
      h.dispose();
    }
  },
);
it('declines public creation before provisioning when an active Templater cannot suppress its automatic hook', async () => {
  const h = await harness();
  try {
    h.projects.taskInsertionSection = '#project';
    Object.defineProperty(h.app, 'plugins', {
      configurable: true,
      value: { getPlugin: () => ({ templater: {} }) },
    });
    expect(await h.writes.create({ name: 'New' })).toMatchObject({
      outcome: 'failed',
      effects: 'unchanged',
      reason: 'unsupported',
    });
    expect(h.app.vault.getAbstractFileByPath('Projects')).toBeNull();
  } finally {
    h.dispose();
  }
});

it('does not reinstall a superseded readback over a newer private source', async () => {
  const h = await harness();
  try {
    const vault = h.app.vault,
      process = vault.process.bind(vault),
      read = vault.read.bind(vault);
    vi.spyOn(vault, 'process').mockImplementationOnce(async (file, transform) => {
      const content = await process(file, transform);
      vi.spyOn(vault, 'read').mockImplementationOnce(async (target) => {
        const old = await read(target);
        await h.external(path, '#private #project');
        return old;
      });
      return content;
    });
    const result = await h.writes.update(h.proof(), { statusId: 'active' });
    expect(result).toEqual({ outcome: 'changed', effects: 'committed' });
    expect(h.reads.get(path)).toMatchObject({ type: 'ok', value: undefined });
  } finally {
    h.dispose();
  }
});

const scalarHeader = '---\nexample: |\n  ---\n';
const sentinel = 'secret: do-not-copy\n---\n#project';
it('excludes private metadata after an indented YAML separator from reading and template creation', async () => {
  const content = `${scalarHeader}tags: [private]\n${sentinel}`;
  const h = await harness({ [path]: content });
  try {
    expect(h.reads.summary(path)).toMatchObject({ type: 'ok', value: undefined });
    h.projects.templatePath = path;
    expect(await h.writes.create({ name: 'New', statusId: null })).toMatchObject({
      outcome: 'failed',
      effects: 'unchanged',
    });
    expect(h.app.vault.getAbstractFileByPath('Projects')).toBeNull();
  } finally {
    h.dispose();
  }
});
it('checks staged private metadata after an indented YAML separator', async () => {
  const h = await harness({ [path]: `${scalarHeader}tags: [visible]\n${sentinel}` });
  try {
    const live = await h.read(path);
    expect(h.reads.guard(h.proof(), live, live.replace('[visible]', '[private]'))).toMatchObject({
      type: 'error',
    });
    expect(
      h.reads.prospective('Projects/New.md', live.replace('[visible]', '[private]')),
    ).toMatchObject({ type: 'error' });
  } finally {
    h.dispose();
  }
});
it('rejects overwriting an unsupported numeric value in BOM-prefixed frontmatter', async () => {
  const content = '\uFEFF---\r\nBudget: wrong\r\nkeep: unrelated\r\n---\r\n#project\r\n';
  const h = await harness({ [path]: content });
  try {
    expect(await h.writes.update(h.proof(), { fields: [budget] })).toMatchObject({
      outcome: 'failed',
      effects: 'unchanged',
    });
    expect(await h.read(path)).toBe(content);
  } finally {
    h.dispose();
  }
});
it.each(['existing header', 'new header'])(
  'keeps a single leading BOM, CRLF and body bytes when writing a %s',
  async (kind) => {
    const body = '#project\r\nbody without terminal newline';
    const header = kind === 'existing header' ? '---\r\nkeep: unrelated\r\n---\r\n' : '';
    const h = await harness({ [path]: `\uFEFF${header}${body}` });
    try {
      expect(await h.writes.update(h.proof(), { fields: [budget] })).toMatchObject({
        outcome: 'changed',
        effects: 'committed',
      });
      expect(await h.read(path)).toBe(
        `\uFEFF---\r\n${header === '' ? '' : 'keep: unrelated\r\n'}Budget: 0\r\n---\r\n${body}`,
      );
    } finally {
      h.dispose();
    }
  },
);
it.each(['  ---\ntags: [private]\n---\n', '---\nexample: |\n  ---\ntags: [private]\n'])(
  'fails closed on ambiguous or unterminated frontmatter before template consumption',
  async (header) => {
    const h = await harness({ [path]: `${header}#project` });
    try {
      expect(h.reads.get(path)).toMatchObject({ type: 'error', reason: 'incomplete' });
      h.projects.templatePath = path;
      expect(await h.writes.create({ name: 'New', statusId: null })).toMatchObject({
        outcome: 'failed',
        effects: 'unchanged',
      });
      expect(h.app.vault.getAbstractFileByPath('Projects')).toBeNull();
    } finally {
      h.dispose();
    }
  },
);

it.each(['  ---', '---  '])(
  'retains ordinary source exclusion for the legacy opening %j while public project reads fail closed',
  async (opening) => {
    const h = await harness({ [path]: `${opening}\ntags: [private]\n---\n#project\n- [ ] secret` });
    try {
      expect(await h.client().tasks.list({ path })).toMatchObject({
        ok: true,
        value: { items: [] },
      });
      expect(h.reads.get(path)).toMatchObject({ type: 'error', reason: 'incomplete' });
    } finally {
      h.dispose();
    }
  },
);

it.each(['~', 'null', '...\ntags: [private]'])(
  'rejects an unsupported or discordant YAML document %j before using its body',
  async (yaml) => {
    const h = await harness({ [path]: `---\n${yaml}\n---\n#project` });
    try {
      expect(h.reads.summary(path)).toMatchObject({ type: 'error', reason: 'incomplete' });
      expect(h.reads.prospective('New.md', `---\n${yaml}\n---\n#project`)).toMatchObject({
        type: 'error',
        reason: 'incomplete',
      });
    } finally {
      h.dispose();
    }
  },
);

it('preserves task exclusion for an unverified legacy closer without authorizing a project', async () => {
  const h = await harness({ [path]: '---\ntags: [private]\n  ---\n#project\n- [ ] secret' });
  try {
    expect(await h.client().tasks.list({ path })).toMatchObject({ ok: true, value: { items: [] } });
    expect(h.reads.summary(path)).toMatchObject({ type: 'error', reason: 'incomplete' });
  } finally {
    h.dispose();
  }
});
