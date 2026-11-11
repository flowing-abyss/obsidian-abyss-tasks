import { expect, it, vi } from 'vitest';
import { decorateTaskTextDifference } from '../src/ui/taskTextDifference';

it('keeps Markdown layout whitespace undecorated while highlighting new text', () => {
  const host = createDiv();
  host.createEl('p', { text: 'A short description.' });
  host.append('\n');
  const list = host.createEl('ul');
  list.append('\n');
  list.createEl('li', { text: 'First step' });
  list.append('\n');
  list.createEl('li', { text: 'Second step' });
  list.append('\n');
  decorateTaskTextDifference(host, '');
  expect([...host.querySelectorAll('ins')].map((node) => node.textContent)).toEqual([
    'A short description.',
    'First step',
    'Second step',
  ]);
  expect(host.querySelector(':scope > ins, ul > ins')).toBeNull();
});

it('isolates separated word replacements and keeps native links interactive', () => {
  const host = createDiv();
  host.append('Проверить светлую тему и ');
  const link = host.createEl('a', { text: 'сохранить фокус', href: '#focus' });
  const clicked = vi.fn();
  link.addEventListener('click', clicked);
  host.append(' на узком экране.');
  decorateTaskTextDifference(host, 'Проверить тёмную тему и сохранить фокус на широком экране.');
  expect([...host.querySelectorAll('ins')].map((node) => node.textContent)).toEqual([
    'светлую',
    'узком',
  ]);
  expect([...host.querySelectorAll('del')].map((node) => node.textContent)).toEqual([
    'тёмную',
    'широком',
  ]);
  expect(link.querySelector('ins, del')).toBeNull();
  link.click();
  expect(clicked).toHaveBeenCalledOnce();
  decorateTaskTextDifference(host, undefined);
  expect(host.textContent).toBe('Проверить светлую тему и сохранить фокус на узком экране.');
});

it('marks removed Markdown text without filling its blocks or losing native nodes', () => {
  const host = createDiv();
  const paragraph = host.createEl('p');
  paragraph.append('Read ');
  const link = paragraph.createEl('a', { text: 'The note', href: '#note' });
  host.append('\n');
  decorateTaskTextDifference(host, undefined, undefined, true);
  expect([...host.querySelectorAll('del')].map((node) => node.textContent)).toEqual([
    'Read',
    'The note',
  ]);
  expect(host.querySelector(':scope > del')).toBeNull();
  decorateTaskTextDifference(host, undefined);
  expect(host.textContent).toBe('Read The note\n');
  expect(host.querySelector('a')).toBe(link);
});
