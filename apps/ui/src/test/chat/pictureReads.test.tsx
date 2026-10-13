import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileBubble } from "../../components/FileBubble";
import { servicesPlatform } from "../../lib/platform";
import type { ChatFile } from "../../lib/types";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: files.paired.images

/** An IntersectionObserver the test moves: `seen` puts a bubble on screen (or near it), or takes it off. */
const observed = new Map<Element, IntersectionObserverCallback>();
/** What each observer was asked to measure against. */
let inits: (IntersectionObserverInit | undefined)[] = [];
class FakeObserver {
  constructor(private readonly callback: IntersectionObserverCallback, init?: IntersectionObserverInit) { inits.push(init); }
  observe(element: Element) { observed.set(element, this.callback); }
  unobserve(element: Element) { observed.delete(element); }
  disconnect() { for (const [element, callback] of observed) if (callback === this.callback) observed.delete(element); }
  takeRecords() { return []; }
}
const seen = (bubbles: HTMLElement[], on = true) => act(() => {
  for (const target of bubbles) {
    observed.get(target)?.([{ target, isIntersecting: on } as unknown as IntersectionObserverEntry], {} as IntersectionObserver);
  }
});

const pictures = (count: number): ChatFile[] => Array.from({ length: count }, (_, i) => ({
  id: `chat1-in-photo${i}`, name: `photo${i}.jpg`, size: 4 * 1024 ** 2, mime: "image/jpeg", image: { width: 400, height: 300 },
}));
const chat = (files: ChatFile[]) => renderApp(<>{files.map((file) => <FileBubble key={file.id} file={file} peerName="Ana" />)}</>);
const settle = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });

/** Reads asked of the platform, answered when the test says. */
let asked: { id: string; answer: () => void }[] = [];
let inFlight = 0, peak = 0;
const { createObjectURL, revokeObjectURL } = URL;
const revoked: string[] = [];

beforeEach(() => {
  asked = []; inFlight = 0; peak = 0; revoked.length = 0;
  observed.clear();
  inits = [];
  vi.stubGlobal("IntersectionObserver", FakeObserver);
  let made = 0;
  URL.createObjectURL = () => `blob:picture-${made++}`;
  URL.revokeObjectURL = (url: string) => { revoked.push(url); };
  vi.spyOn(servicesPlatform!, "getFile").mockImplementation((id: string) => new Promise((resolve) => {
    inFlight++; peak = Math.max(peak, inFlight);
    let answered = false;
    asked.push({ id, answer: () => {
      if (answered) return;
      answered = true;
      inFlight--;
      resolve(new Blob(["jpeg"], { type: "image/jpeg" }));
    } });
  }));
  fakeEngine.update({ links: [linkView({ id: "chat1" })], transfers: {} });
});

afterEach(() => {
  vi.unstubAllGlobals();
  Object.assign(URL, { createObjectURL, revokeObjectURL });
});

describe("a chat's pictures are read as they come on screen, a few at a time, once a run", () => {
  it("a chat opening with 100 received pictures reads only those on screen", async () => {
    chat(pictures(100));
    await settle();
    // Nothing is on screen yet: nothing is read.
    expect(asked).toEqual([]);
    const bubbles = screen.getAllByTestId("file-bubble");
    seen(bubbles.slice(-4));
    await settle();
    expect(asked.map((read) => read.id).sort()).toEqual(["chat1-in-photo96", "chat1-in-photo97", "chat1-in-photo98"]);
    // A few at a time: the fourth waits for one of them.
    act(() => asked[0].answer());
    await settle();
    expect(asked).toHaveLength(4);
    for (const read of asked.slice(1)) act(() => read.answer());
    await settle();
    expect(peak).toBe(3);
    expect(screen.getAllByRole("img")).toHaveLength(4);
  });

  it("a picture that leaves the screen before its turn is not read", async () => {
    chat(pictures(10));
    const bubbles = screen.getAllByTestId("file-bubble");
    seen(bubbles);
    await settle();
    expect(asked).toHaveLength(3);
    // Scrolled on past the rest before any came.
    seen(bubbles.slice(3), false);
    for (const read of [...asked]) act(() => read.answer());
    await settle();
    expect(asked).toHaveLength(3);
  });

  it("a chat opened again reads none of the pictures it showed, and their addresses are not given back under them", async () => {
    const files = pictures(6);
    const first = chat(files);
    seen(screen.getAllByTestId("file-bubble"));
    for (let i = 0; i < 6; i++) { await settle(); for (const read of [...asked]) act(() => read.answer()); }
    await settle();
    const shown = screen.getAllByRole("img").map((img) => img.getAttribute("src"));
    expect(shown).toHaveLength(6);
    expect(asked).toHaveLength(6);
    first.unmount();
    expect(revoked).toEqual([]);

    chat(files);
    seen(screen.getAllByTestId("file-bubble"));
    await settle();
    expect(asked).toHaveLength(6);
    expect(screen.getAllByRole("img").map((img) => img.getAttribute("src"))).toEqual(shown);
  });

  it("a picture is read 400 px before it scrolls into the chat list's view, more than a fast wheel notch moves it", () => {
    renderApp(<div data-testid="list" data-message-list>{pictures(2).map((file) => <FileBubble key={file.id} file={file} peerName="Ana" />)}</div>);
    // Measured against the window, the margin would stop at the list's edge: the list scrolls inside it.
    expect(inits).toHaveLength(2);
    for (const init of inits) expect(init).toMatchObject({ root: screen.getByTestId("list"), rootMargin: "400px 0px" });
  });
});
