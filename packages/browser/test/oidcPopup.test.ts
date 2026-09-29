import { afterEach, describe, expect, it, vi } from "vitest";
import { CALLBACK_PATH, OIDC_CHANNEL, popupWindow } from "../src/proofs/oidc/popup";
// covers: proofs.oidc, proofs.oidc.callback.web

/**
 * The web sign-in window (proofs/oidc/popup.ts): the answer is taken only from this origin's channel,
 * only in the expected shape and only for the state this request sent; blocked pop-ups, a cancel and
 * a ten-minute wait end it; closing it releases the channel and the window.
 */

const STATE = "s".repeat(43);
const AUTHORIZE = `https://accounts.example/authorize?client_id=x&state=${STATE}`;
const callback = (state: string) => `https://app.ghostly.tools${CALLBACK_PATH}#id_token=t&state=${state}`;

function fakePopup(opened = true) {
  const popup = { location: { href: "about:blank" }, closed: false, close: vi.fn(function (this: { closed: boolean }) { this.closed = true; }) };
  const open = vi.fn(() => (opened ? popup : null));
  vi.stubGlobal("window", { open });
  return { popup, open };
}
/** What the callback page posts, from another context of this origin. */
function post(data: unknown) {
  const sender = new BroadcastChannel(OIDC_CHANNEL);
  sender.postMessage(data);
  sender.close();
}
const tick = () => new Promise(r => setTimeout(r, 20));

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("the sign-in pop-up", () => {
  it("opens at once on this origin, then goes to the provider; answers for another request or in another shape are ignored", async () => {
    const { popup, open } = fakePopup();
    const w = popupWindow("https://app.ghostly.tools");
    expect(open).toHaveBeenCalledWith("about:blank", "ghostly-oidc", expect.stringContaining("popup"));
    expect(w.redirectUri).toBe(`https://app.ghostly.tools${CALLBACK_PATH}`);
    const answer = w.authorize(AUTHORIZE, new AbortController().signal);
    expect(popup.location.href).toBe(AUTHORIZE);
    let settled = false;
    void answer.then(() => { settled = true; });
    post(null);
    post({ type: "other", url: callback(STATE) });
    post({ type: OIDC_CHANNEL, url: 42 });
    post({ type: OIDC_CHANNEL, url: "not a url" });
    post({ type: OIDC_CHANNEL, url: callback("t".repeat(43)) });
    await tick();
    expect(settled).toBe(false);
    post({ type: OIDC_CHANNEL, url: callback(STATE) });
    expect(await answer).toBe(callback(STATE));
    w.close();
    expect(popup.close).toHaveBeenCalled();
  });

  it("a blocked pop-up asks the person to allow them", async () => {
    fakePopup(false);
    const w = popupWindow("https://app.ghostly.tools");
    await expect(w.authorize(AUTHORIZE, new AbortController().signal)).rejects.toThrow(/Allow pop-ups/);
    w.close();
  });

  it("cancelling ends the wait, and a late answer changes nothing", async () => {
    fakePopup();
    const w = popupWindow("https://app.ghostly.tools");
    const controller = new AbortController();
    const answer = w.authorize(AUTHORIZE, controller.signal);
    controller.abort();
    await expect(answer).rejects.toThrow(/cancelled/);
    post({ type: OIDC_CHANNEL, url: callback(STATE) });
    await tick();
    w.close();
  });

  it("gives up after ten minutes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fakePopup();
    const w = popupWindow("https://app.ghostly.tools");
    const answer = expect(w.authorize(AUTHORIZE, new AbortController().signal)).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await answer;
    w.close();
  });

  it("closing a window already closed, or one another origin will not let go, does not throw", () => {
    const { popup } = fakePopup();
    const w = popupWindow("https://app.ghostly.tools");
    popup.close.mockImplementation(() => { throw new Error("SecurityError"); });
    expect(() => w.close()).not.toThrow();
    popup.closed = true;
    popup.close.mockClear();
    const again = popupWindow("https://app.ghostly.tools");
    again.close();
    expect(popup.close).not.toHaveBeenCalled();
  });
});
