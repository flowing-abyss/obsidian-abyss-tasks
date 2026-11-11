import { vi } from 'vitest';

// Takes the place of obsidian-test-mocks/vitest-setup, which does both of the following in every
// suite. Every suite gets the mocked `obsidian` module. The package's setup() extends the DOM's
// prototypes and installs Obsidian's global helpers (the additions to `Array`, `String`, `Math`,
// `Number`, and `Object`, `createEl` and its family, `sleep`, `activeWindow`, a global `app`, and
// more), so it runs only where a DOM exists: a suite on the Node environment (a
// `// @vitest-environment node` first line) has none of them.
if (typeof Document === 'function') {
  const { setup } = await import('obsidian-test-mocks/setup');
  setup();
  // Connected hidden surfaces observe layout before jsdom can supply any geometry.
  // Geometry-focused suites replace these native defaults with controllable observers.
  window.ResizeObserver = class implements ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  Object.defineProperty(document, 'fonts', { value: new EventTarget(), configurable: true });
}
const obsidian = await import('obsidian-test-mocks/obsidian');
// The upstream text adapter records UTF-16 length and cannot read text as binary.
// Native Vault.stat.size and readBinary describe UTF-8 bytes, including the BOM.
const method = <T extends object, K extends keyof T>(owner: T, key: K): T[K] => owner[key];
const refreshStat__ = method(obsidian.Vault.prototype, 'refreshStat__');
const readBinary = method(obsidian.Vault.prototype, 'readBinary');
obsidian.Vault.prototype.refreshStat__ = function (file) {
  refreshStat__.call(this, file);
  try {
    file.stat.size = new TextEncoder().encode(this.readSync__(file)).byteLength;
  } catch {
    // Binary fixtures keep their original native byte size.
  }
};
obsidian.Vault.prototype.readBinary = function (file) {
  try {
    return Promise.resolve(new TextEncoder().encode(this.readSync__(file)).buffer);
  } catch {
    return readBinary.call(this, file);
  }
};

vi.mock('obsidian', async () => {
  const obsidian = await import('obsidian-test-mocks/obsidian');
  const { InspectorModalMock } = await import('../support/inspectorModalMock');
  return {
    ...obsidian,
    Modal: InspectorModalMock,
  };
});
