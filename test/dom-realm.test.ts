import { describe, expect, it } from 'vitest';
import { isRealmHTMLElement } from '../src/ui/domRealm';

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
});
