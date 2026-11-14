import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageInput } from "../../components/MessageInput";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { findSecret } from "../../lib/parse/secrets";
import { forgetGroupLocal } from "../../lib/groups";
import { deleteSession, getPrefix } from "../../lib/storage";
import { renderApp } from "../render";

// covers: app.composer.secret-guard

// The guard reads the whole draft: counted here, its rules untouched.
vi.mock("../../lib/parse/secrets", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../lib/parse/secrets")>();
  return { ...real, findSecret: vi.fn(real.findSecret) };
});

/** BIP39's test vector for entropy 0x7f repeated: it has never held anything. */
const SEED = "legal winner thank year wave sausage worth useful legal winner thank yellow";

function composer(draftId = "draft-save") {
  return renderApp(<LockScreenProvider><MessageInput draftId={draftId} onSend={vi.fn(async () => null)} /></LockScreenProvider>);
}
const field = () => screen.getByPlaceholderText<HTMLTextAreaElement>("Message…");
/** What storage holds, read past the app (whose read would write a pending draft first). */
const stored = (id = "draft-save") => localStorage.getItem(`${getPrefix()}draft_${id}`);
/** One key at a time, at once: no pause in the typing. */
const type = (words: string) => act(() => { for (let i = 1; i <= words.length; i++) fireEvent.change(field(), { target: { value: words.slice(0, i) } }); });
const pause = () => new Promise((resolve) => setTimeout(resolve, 600));

afterEach(() => { vi.mocked(findSecret).mockClear(); });

describe("the stored draft", () => {
  it("is guarded once per pause in the typing, not once per key", async () => {
    composer();
    await waitFor(() => expect(stored()).toBeNull());
    vi.mocked(findSecret).mockClear();
    type("a long message, one key at a time");
    expect(findSecret).not.toHaveBeenCalled();
    await waitFor(() => expect(stored()).toBe("a long message, one key at a time"));
    expect(findSecret).toHaveBeenCalledTimes(1);
  });

  it("holds the last key when the page goes right after it", () => {
    composer();
    type("half a sentence");
    act(() => { window.dispatchEvent(new Event("pagehide")); });
    expect(stored()).toBe("half a sentence");
  });

  it("holds the last key when the page is hidden right after it", () => {
    composer();
    type("half a sentence");
    const hidden = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    try { act(() => { document.dispatchEvent(new Event("visibilitychange")); }); } finally { hidden.mockRestore(); }
    expect(stored()).toBe("half a sentence");
  });

  it("holds the last key when the composer goes (another chat opened) right after it", () => {
    const { unmount } = composer();
    type("half a sentence");
    unmount();
    expect(stored()).toBe("half a sentence");
  });

  it("stays cleared when its group is left during the pause", async () => {
    const { unmount } = composer("group:g1");
    type("half a sentence");
    act(() => forgetGroupLocal("g1"));
    await pause();
    unmount();
    expect(stored("group:g1")).toBeNull();
  });

  it("stays cleared when its chat is deleted during the pause", async () => {
    const { unmount } = composer();
    type("half a sentence");
    act(() => deleteSession("draft-save"));
    await pause();
    unmount();
    expect(stored()).toBeNull();
  });

  it("never holds a seed, written after a pause or as the page goes", async () => {
    const written = vi.spyOn(Storage.prototype, "setItem");
    try {
      const { unmount } = composer();
      type("hello ");
      await waitFor(() => expect(stored()).toBe("hello "));
      type(`hello ${SEED}`);
      await pause();
      expect(stored()).toBeNull();
      type(`hello ${SEED} again`);
      act(() => { window.dispatchEvent(new Event("pagehide")); });
      unmount();
      expect(stored()).toBeNull();
      expect(written.mock.calls.filter(([, value]) => value.includes("legal winner"))).toEqual([]);
    } finally { written.mockRestore(); }
  });
});
