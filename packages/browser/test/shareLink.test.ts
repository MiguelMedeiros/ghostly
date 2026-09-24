import { afterEach, describe, expect, it, vi } from 'vitest';

/** The share sheet the desktop host offers, when a test gives one. */
const platform = vi.hoisted(() => ({ shareText: null as null | ((text: string, anchor?: unknown) => Promise<boolean> | null) }));
vi.mock('../../../src/lib/platform', () => ({
  servicesPlatform: { shareText: (text: string, anchor?: unknown) => platform.shareText ? platform.shareText(text, anchor) : null },
}));
const { shareLink } = await import('../../../src/lib/shareLink');
// covers: groups.link.share

const URL_ = 'https://app.ghostly.tools/#/join/group1/AAAAAAAAAAAAAAAAAAAAAA/ybndrfg8ejkmcpqxot1uwisza345h769ybndrfg8ejkmcpqxot1u';

function browser(share?: (data: ShareData) => Promise<void>) {
  const copied: string[] = [];
  vi.stubGlobal('navigator', { share, clipboard: { writeText: async (text: string) => { copied.push(text); } } });
  return copied;
}

/**
 * Share on a group's link (src/lib/shareLink.ts): the system's sheet where the host has one
 * (desktop), the Web Share API where the page has it, and a copy otherwise.
 */
describe('sharing a link', () => {
  afterEach(() => { vi.unstubAllGlobals(); platform.shareText = null; });

  it('uses the desktop host\'s share sheet, pointing at the button', async () => {
    const copied = browser(async () => { throw new Error('not this one'); });
    const calls: unknown[] = [];
    platform.shareText = async (text, anchor) => { calls.push([text, anchor]); return true; };
    const button = { getBoundingClientRect: () => ({ x: 10, y: 20, width: 30, height: 40 }) } as unknown as HTMLElement;
    expect(await shareLink(URL_, 'Join', button)).toBe('shared');
    expect(calls).toEqual([[URL_, { x: 10, y: 20, width: 30, height: 40 }]]);
    expect(copied).toEqual([]);
  });

  it('falls through when the host has no sheet on this system (Linux, Windows)', async () => {
    const copied = browser();
    platform.shareText = async () => false;
    expect(await shareLink(URL_, 'Join')).toBe('copied');
    expect(copied).toEqual([URL_]);
  });

  it('uses the Web Share API, and a dismissed sheet is not a failure', async () => {
    const shared: ShareData[] = [];
    browser(async data => { shared.push(data); });
    expect(await shareLink(URL_, 'Join Ghosts on Ghostly')).toBe('shared');
    expect(shared).toEqual([{ title: 'Join Ghosts on Ghostly', url: URL_ }]);
    const copied = browser(async () => { throw new DOMException('dismissed', 'AbortError'); });
    expect(await shareLink(URL_, 'Join')).toBe('cancelled');
    expect(copied).toEqual([]);
  });

  it('copies when there is no way to share, or sharing fails', async () => {
    const copied = browser();
    expect(await shareLink(URL_, 'Join')).toBe('copied');
    expect(copied).toEqual([URL_]);
    const again = browser(async () => { throw new DOMException('nope', 'NotAllowedError'); });
    expect(await shareLink(URL_, 'Join')).toBe('copied');
    expect(again).toEqual([URL_]);
  });
});
