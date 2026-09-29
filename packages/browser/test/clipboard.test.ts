import { afterEach, describe, expect, it, vi } from 'vitest';

/** The native read the desktop host offers, when a test gives one. */
const platform = vi.hoisted(() => ({ readClipboardText: null as null | (() => Promise<string>) }));
vi.mock('../../../src/lib/platform', () => ({
  servicesPlatform: { readClipboardText: () => platform.readClipboardText ? platform.readClipboardText() : null },
}));
const { pasteShortcut, readClipboardText } = await import('../../../src/lib/clipboard');
// covers: invite.clipboard

/** A page whose Clipboard API answers `readText`, with or without a click's user activation. */
function page({ readText, active, platform: os = 'MacIntel', userAgentData }: { readText?: () => Promise<string>; active?: boolean; platform?: string; userAgentData?: { platform: string } } = {}) {
  const reads: string[] = [];
  vi.stubGlobal('navigator', {
    platform: os,
    userAgent: '',
    userAgentData,
    userActivation: active === undefined ? undefined : { isActive: active, hasBeenActive: true },
    clipboard: readText ? { readText: async () => { reads.push('web'); return readText(); } } : undefined,
  });
  return reads;
}

/**
 * Paste buttons (src/lib/clipboard.ts): the desktop host reads natively, so WKWebView's "Paste"
 * callout never needs a second click; web and extension use the Clipboard API; any refusal is
 * null, and the caller shows a field and the shortcut instead of a dead button.
 */
describe('reading the clipboard for a paste button', () => {
  afterEach(() => { vi.unstubAllGlobals(); platform.readClipboardText = null; });

  it('reads through the desktop host, never the Clipboard API (no WebKit callout)', async () => {
    const web = page({ readText: async () => 'from the web API', active: true });
    platform.readClipboardText = async () => 'ghostly invite';
    expect(await readClipboardText()).toBe('ghostly invite');
    expect(web).toEqual([]);
  });

  it('a refused native read is null, without falling back to the callout', async () => {
    const web = page({ readText: async () => 'from the web API', active: true });
    platform.readClipboardText = async () => { throw new Error('Not allowed from this window'); };
    expect(await readClipboardText()).toBeNull();
    expect(web).toEqual([]);
  });

  it('asks nothing without a click\'s user activation', async () => {
    const asked: string[] = [];
    const web = page({ readText: async () => 'x', active: false });
    platform.readClipboardText = async () => { asked.push('native'); return 'x'; };
    expect(await readClipboardText()).toBeNull();
    expect(asked).toEqual([]);
    platform.readClipboardText = null;
    expect(await readClipboardText()).toBeNull();
    expect(web).toEqual([]);
  });

  it('where the page has no user activation API (older WebKit), the click is trusted', async () => {
    page({});
    platform.readClipboardText = async () => 'text';
    expect(await readClipboardText()).toBe('text');
  });

  it('uses the Clipboard API on the web and in the extension; empty stays empty', async () => {
    page({ readText: async () => 'web invite', active: true });
    expect(await readClipboardText()).toBe('web invite');
    page({ readText: async () => '', active: true });
    expect(await readClipboardText()).toBe('');
  });

  it('a denied, missing or throwing Clipboard API is null', async () => {
    page({ readText: async () => { throw new DOMException('denied', 'NotAllowedError'); }, active: true });
    expect(await readClipboardText()).toBeNull();
    page({ active: true });
    expect(await readClipboardText()).toBeNull();
  });

  it('names the paste keys of this device', () => {
    page({ platform: 'MacIntel' });
    expect(pasteShortcut()).toBe('⌘V');
    page({ platform: 'Win32' });
    expect(pasteShortcut()).toBe('Ctrl+V');
    page({ platform: 'Linux x86_64' });
    expect(pasteShortcut()).toBe('Ctrl+V');
    page({ platform: 'Win32', userAgentData: { platform: 'macOS' } });
    expect(pasteShortcut()).toBe('⌘V');
  });
});
