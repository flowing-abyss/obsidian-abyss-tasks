import { describe, expect, it } from 'vitest';
import { isRealmHTMLElement, isRealmNode } from '../src/ui/domRealm';

describe('isRealmHTMLElement', () => {
  it('rejects null and non-element targets', () => {
    expect(isRealmHTMLElement(null)).toBe(false);
    expect(isRealmHTMLElement(new EventTarget())).toBe(false);
    expect(isRealmHTMLElement(document.createTextNode('x'))).toBe(false);
  });

  it('accepts an element of the main document', () => {
    expect(isRealmHTMLElement(document.body.createDiv())).toBe(true);
  });

  it('accepts an element created in a popout realm', () => {
    const iframe = document.body.createEl('iframe');
    const foreignDocument = iframe.contentDocument;
    if (foreignDocument == null) throw new Error('missing iframe realm');
    const foreign = foreignDocument.createElementNS('http://www.w3.org/1999/xhtml', 'div');
    expect(foreign).not.toBeInstanceOf(HTMLElement);
    expect(isRealmHTMLElement(foreign)).toBe(true);
    iframe.remove();
  });

  it('accepts a plugin element that a popout document holds', () => {
    const iframe = document.body.createEl('iframe');
    try {
      const popoutDocument = iframe.contentDocument;
      const popoutWindow = iframe.contentWindow as (Window & typeof window) | null;
      if (popoutDocument == null || popoutWindow == null) throw new Error('missing iframe realm');
      // `createDiv` builds through the main document; the append moves the element, as in Obsidian.
      const plugin = document.body.createDiv();
      popoutDocument.body.append(plugin);

      expect(plugin.ownerDocument).toBe(popoutDocument);
      expect(plugin).toBeInstanceOf(HTMLElement);
      expect(plugin).not.toBeInstanceOf(popoutWindow.HTMLElement);
      // A helper that accepts only the owner document's realm rejects the plugin's own element.
      expect(isRealmHTMLElement(plugin)).toBe(true);
    } finally {
      iframe.remove();
    }
  });
});

it('checks specific DOM node types in the owning window, including its document', () => {
  const frame = document.body.createEl('iframe');
  try {
    const other = frame.contentDocument;
    if (other === null) throw new Error('missing iframe document');
    const svg = other.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const input = other.createElementNS('http://www.w3.org/1999/xhtml', 'input');
    expect(isRealmNode(svg, 'Element')).toBe(true);
    expect(isRealmNode(input, 'HTMLInputElement')).toBe(true);
    expect(isRealmNode(input, 'HTMLTextAreaElement')).toBe(false);
    expect(isRealmNode(other, 'Node')).toBe(true);
    expect(isRealmNode(other.createTextNode('x'), 'Element')).toBe(false);
    expect(isRealmNode(new EventTarget(), 'Node')).toBe(false);
  } finally {
    frame.remove();
  }
});
