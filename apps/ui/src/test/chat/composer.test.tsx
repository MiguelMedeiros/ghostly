import { act, fireEvent, screen, waitFor, within, render } from "@testing-library/react";
import { Profiler, type ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageInput } from "../../components/MessageInput";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { loadEmoji } from "../../lib/emoji";
import { resetGifSearch } from "../../lib/gifSearch";
import { setStorageProfile as setProfile } from "../../lib/storage";
import { renderApp, AppProviders } from "../render";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { installFakeAudio, installFakeMedia, removeFakeMedia } from "../voice/fakeMedia";
import type { Language } from "../../lib/settings";

// covers: app.composer.attach, app.composer.expressions, app.emoji-picker, chat.paired.emoji, chat.paired.gifs, chat.paired.gifs.categories, chat.paired.gifs.busy

// The emoji panel's data set, here before any panel opens (its loading: emojiPanelLoad.test.tsx).
beforeAll(() => loadEmoji());

const viewport = (width: number, height = 800) => (window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM.setViewport({ width, height });

const onSend = vi.fn<(text: string) => Promise<string | null>>();
const onSendFile = vi.fn<(file: File) => Promise<string | null>>();

type Props = Partial<Parameters<typeof MessageInput>[0]>;
/** A 1:1 chat's composer with everything the + can offer, unless `props` says otherwise. */
function composer(props: Props = {}) {
  return renderApp(<LockScreenProvider><MessageInput onSend={onSend} onSendFile={onSendFile} identities={{ peerKey: "peer", contact: "Alice" }}
    paymentComposer={(close) => <div data-testid="stub-payment"><button onClick={close}>Close payment</button></div>} {...props} /></LockScreenProvider>);
}

const plus = () => screen.getByTestId("composer-more");
const smiley = () => screen.getByTestId("composer-expressions");
const field = () => screen.getByPlaceholderText<HTMLTextAreaElement>("Message…");
const rows = () => within(screen.getByTestId("composer-menu")).getAllByRole("button");

function withCamera(has: boolean) {
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
    getUserMedia: vi.fn(),
    enumerateDevices: vi.fn(async () => has ? [{ kind: "videoinput", deviceId: "", label: "", groupId: "" }] : [{ kind: "audioinput", deviceId: "", label: "", groupId: "" }]),
  } });
}

/** GifCities, answering every search with `count` GIFs named after it. */
function gifCities(count = 3) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const q = new URL(String(input)).searchParams.get("q")!;
    return new Response(JSON.stringify(Array.from({ length: count }, (_, i) => ({ gif: `http://geocities.com/${q.replace(/\s/g, "_")}${i}.gif`, url_text: `${q} ${i}`, checksum: `${q}-${i}` }))));
  });
}

/** The page the Internet Archive answers with once an IP has asked too much: a 200, in HTML, not a 429. */
const rateLimitPage = () => new Response("<!DOCTYPE html><html><head><title>Rate limit reached</title></head><body><h1>Rate limit reached</h1>"
  + "<p>You've reached the limit for the number of requests that can be made in a short period of time. Please wait a moment and try again.</p></body></html>",
{ headers: { "content-type": "text/html; charset=utf-8" } });

beforeEach(() => {
  onSend.mockReset().mockResolvedValue(null);
  onSendFile.mockReset().mockResolvedValue(null);
});
afterEach(() => {
  vi.useRealTimers();
  viewport(1024, 768);
  Reflect.deleteProperty(navigator, "mediaDevices");
  setProfile("");
  vi.restoreAllMocks();
});

describe("the focus when a chat opens", () => {
  /** A touch screen with no mouse (`any-pointer` coarse, never fine), or a mouse. */
  function pointer(touch: boolean) {
    const matchMedia = window.matchMedia.bind(window);
    vi.spyOn(window, "matchMedia").mockImplementation((query: string) =>
      query === "(any-pointer: coarse)" || query === "(any-pointer: fine)"
        ? ({ ...matchMedia(query), matches: query === "(any-pointer: coarse)" ? touch : !touch } as MediaQueryList)
        : matchMedia(query));
  }

  it("with a mouse, the message field has it", () => {
    pointer(false);
    composer();
    expect(field()).toHaveFocus();
  });

  it("on a touch screen, nothing takes it: the keyboard stays down until the field is tapped", () => {
    pointer(true);
    composer();
    expect(field()).not.toHaveFocus();
  });
});

describe("the composer bar", () => {
  it("reads [+] [emoji/GIF] [message] and then send, in that order", () => {
    composer({ onSendFile: undefined });
    const order = [plus(), smiley(), field(), screen.getByRole("button", { name: "Send message" })];
    for (let i = 1; i < order.length; i++) expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The +, the smiley and the message share one rounded field.
    expect(plus().closest(".composer-field")).toBe(field().closest(".composer-field"));
    expect(smiley().closest(".composer-field")).toBe(field().closest(".composer-field"));
  });

  it("is all disabled while the chat cannot send", () => {
    composer({ disabled: true });
    expect(plus()).toBeDisabled();
    expect(smiley()).toBeDisabled();
  });
});

describe("the + menu", () => {
  it("offers payment, identity, document and photos in a 1:1 chat, each with its coloured icon", async () => {
    const { user } = composer();
    await user.click(plus());
    expect(plus()).toHaveAttribute("aria-expanded", "true");
    expect(rows().map((r) => r.textContent)).toEqual(["Payment", "Identity", "Document", "Photos & videos"]);
    expect(rows().map((r) => r.querySelector(".composer-menu-icon")?.getAttribute("data-action"))).toEqual(["payment", "identity", "document", "media"]);
    // A popover from the + on a wide screen, lined up with its start.
    expect(screen.getByTestId("composer-menu")).toHaveAttribute("data-menu", "popover");
    expect(screen.getByTestId("composer-menu").className).toMatch(/\bstart-0\b/);
  });

  it("opens upward over the +, the way a composer's menu goes", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      // The + near the bottom of the window, with the whole chat above it.
      const box = this.dataset.testid === "composer-menu" ? { left: 16, right: 240, top: 772, bottom: 1000 } : this.contains(document.querySelector("[data-testid=composer-more]")) ? { left: 16, right: 56, top: 720, bottom: 760 } : { left: 0, right: 0, top: 0, bottom: 0 };
      return { ...box, x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top, toJSON: () => box } as DOMRect;
    });
    const { user } = composer();
    await user.click(plus());
    expect(screen.getByTestId("composer-menu").className).toMatch(/\bbottom-full\b/);
  });

  it("has a Camera row only where there is a camera", async () => {
    withCamera(true);
    const { user, unmount } = composer();
    await waitFor(() => expect(navigator.mediaDevices.enumerateDevices).toHaveBeenCalled());
    await user.click(plus());
    expect(rows().map((r) => r.dataset.action)).toEqual(["payment", "identity", "document", "media", "camera"]);
    unmount();
    withCamera(false);
    const again = composer();
    await waitFor(() => expect(navigator.mediaDevices.enumerateDevices).toHaveBeenCalled());
    await again.user.click(plus());
    expect(rows().map((r) => r.dataset.action)).not.toContain("camera");
  });

  it("shows what cannot be used now greyed, with the reason", async () => {
    const { user } = composer({ paymentsUnavailable: "Connect and confirm your peer to send sats", fileUnavailable: "DHT carries text only. Choose a live connection for files." });
    await user.click(plus());
    const pay = screen.getByTestId("payment-button"), doc = screen.getByTestId("composer-file");
    expect(pay).toBeDisabled();
    expect(pay).toHaveAttribute("title", "Connect and confirm your peer to send sats");
    expect(pay).toHaveTextContent("PaymentConnect and confirm your peer to send sats");
    expect(doc).toBeDisabled();
    expect(doc).toHaveAttribute("title", "DHT carries text only. Choose a live connection for files.");
    expect(screen.getByTestId("composer-identities-button")).toBeEnabled();
  });

  it("moves with the arrow keys over the rows that can be used, opens one with Enter, and Escape gives the focus back to the +", async () => {
    const { user } = composer({ fileUnavailable: "Files are not part of groups yet" });
    plus().focus();
    await user.keyboard("{Enter}");
    // The first row takes the focus as the menu opens.
    await waitFor(() => expect(screen.getByTestId("payment-button")).toHaveFocus());
    await user.keyboard("{ArrowDown}");
    expect(screen.getByTestId("composer-identities-button")).toHaveFocus();
    // Document and Photos are greyed out: the keys skip them and wrap.
    await user.keyboard("{ArrowDown}");
    expect(screen.getByTestId("payment-button")).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(screen.getByTestId("composer-identities-button")).toHaveFocus();
    await user.keyboard("{Home}");
    expect(screen.getByTestId("payment-button")).toHaveFocus();
    await user.keyboard("{End}");
    expect(screen.getByTestId("composer-identities-button")).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("composer-menu")).not.toBeInTheDocument();
    expect(plus()).toHaveFocus();
    expect(plus()).toHaveAttribute("aria-expanded", "false");

    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByTestId("payment-button")).toHaveFocus());
    await user.keyboard("{Enter}");
    expect(screen.queryByTestId("composer-menu")).not.toBeInTheDocument();
    expect(screen.getByTestId("stub-payment")).toBeInTheDocument();
  });

  it("Document opens the file picker and Photos & videos one for pictures and videos; what is chosen is sent", async () => {
    const { user } = composer();
    const files = screen.getByTestId<HTMLInputElement>("file-input"), media = screen.getByTestId<HTMLInputElement>("media-input");
    const fileClick = vi.spyOn(files, "click"), mediaClick = vi.spyOn(media, "click");
    await user.click(plus());
    await user.click(screen.getByTestId("composer-file"));
    expect(fileClick).toHaveBeenCalledOnce();
    await user.click(plus());
    await user.click(screen.getByTestId("composer-media"));
    expect(mediaClick).toHaveBeenCalledOnce();
    expect(media).toHaveAttribute("accept", "image/*,video/*");
    expect(media).toHaveAttribute("multiple");
    const photos = [new File(["a"], "a.jpg", { type: "image/jpeg" }), new File(["b"], "b.mp4", { type: "video/mp4" })];
    await user.upload(media, photos);
    await waitFor(() => expect(onSendFile.mock.calls.map(([f]) => f.name)).toEqual(["a.jpg", "b.mp4"]));
    // Several documents at once too, each its own message.
    expect(files).toHaveAttribute("multiple");
    await user.upload(files, [new File(["c"], "c.pdf", { type: "application/pdf" }), new File(["d"], "d.txt", { type: "text/plain" })]);
    await waitFor(() => expect(onSendFile.mock.calls.map(([f]) => f.name)).toEqual(["a.jpg", "b.mp4", "c.pdf", "d.txt"]));
  });

  it("a file the chat refuses before it goes (the contact's app takes none, a stopped chat) says why, and the next waits", async () => {
    onSendFile.mockResolvedValueOnce("Connect to an updated peer to send files");
    composer();
    const files = screen.getByTestId<HTMLInputElement>("file-input");
    fireEvent.change(files, { target: { files: [new File(["a"], "a.pdf", { type: "application/pdf" }), new File(["b"], "b.pdf", { type: "application/pdf" })] } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Connect to an updated peer to send files");
    // The first that cannot go stops the rest.
    expect(onSendFile.mock.calls.map(([f]) => f.name)).toEqual(["a.pdf"]);
  });

  it("is a sheet from the bottom on a phone", async () => {
    viewport(390, 844);
    const { user } = composer();
    await user.click(plus());
    const sheet = screen.getByTestId("composer-menu");
    expect(sheet).toHaveAttribute("data-menu", "sheet");
    expect(sheet.parentElement).toBe(document.body);
    expect(screen.getByTestId("menu-backdrop")).toBeInTheDocument();
    await user.click(screen.getByTestId("composer-identities-button"));
    expect(screen.queryByTestId("composer-menu")).not.toBeInTheDocument();
    expect(screen.getByTestId("composer-identities")).toBeInTheDocument();
  });

  it("in a group, offers only what groups carry", async () => {
    const { user } = renderApp(<MessageInput onSend={onSend} paymentComposer={() => <div />} fileUnavailable="Files are not part of groups yet" />);
    await user.click(plus());
    expect(rows().map((r) => r.dataset.action)).toEqual(["payment"]);
  });

  it("speaks the app's language", async () => {
    const { user } = renderApp(<MessageInput onSend={onSend} onSendFile={onSendFile} paymentComposer={() => <div />} />, { language: "pt" });
    await user.click(screen.getByRole("button", { name: "Anexar" }));
    expect(rows().map((r) => r.textContent)).toEqual(["Pagamento", "Documento", "Fotos e vídeos"]);
  });
});

describe("the emoji/GIF panel", () => {
  it("on a phone is a sheet of half the screen, and all it may be with the keyboard up (a search)", async () => {
    viewport(390, 844);
    const { user } = composer();
    await user.click(smiley());
    const height = () => screen.getByTestId("expression-panel").style.getPropertyValue("--expression-height");
    expect(height()).toBe(`${Math.round(844 * 0.52)}px`);
    await user.click(smiley());
    document.documentElement.dataset.keyboard = "true";
    try {
      await user.click(smiley());
      expect(height()).toBe(`${Math.round(844 * 0.82)}px`);
    } finally {
      delete document.documentElement.dataset.keyboard;
    }
  });

  it("on a phone on its side takes more than half the screen, so the grid keeps room for emoji rows", async () => {
    const height = () => screen.getByTestId("expression-panel").style.getPropertyValue("--expression-height");
    viewport(568, 320);
    const { user } = composer();
    await user.click(smiley());
    // Half (166 px) would leave the grid 8 px under the categories, the search and the switch.
    expect(height()).toBe(`${Math.round(320 * 0.82)}px`);
    viewport(667, 375);
    window.dispatchEvent(new Event("resize"));
    await waitFor(() => expect(height()).toBe("290px"));
    // A phone held upright keeps its half.
    viewport(320, 568);
    window.dispatchEvent(new Event("resize"));
    await waitFor(() => expect(height()).toBe(`${Math.round(568 * 0.52)}px`));
  });

  it("renders again only when it moves: not for a scroll or a resize that leaves it in place, nor for its own grid's scroll", async () => {
    viewport(390, 844);
    // The visual viewport a phone has (happy-dom has none): the sheet stands on it.
    const visual = Object.assign(new EventTarget(), { width: 390, height: 844, offsetLeft: 0, offsetTop: 0 });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: visual });
    let commits = 0;
    try {
      const { user } = renderApp(<Profiler id="composer" onRender={() => { commits++; }}><LockScreenProvider>
        <MessageInput onSend={onSend} onSendFile={onSendFile} identities={{ peerKey: "peer", contact: "Alice" }} /></LockScreenProvider></Profiler>);
      const frame = () => act(() => new Promise<void>((done) => requestAnimationFrame(() => done())));
      const grid = () => screen.getByTestId("emoji-grid");
      await user.click(smiley());
      // The grid's first scrolls pick its category (all at the top here) and React checks once more that it stayed:
      // the grid's own business, not the panel's place.
      for (let i = 0; i < 2; i++) { fireEvent.scroll(grid()); await frame(); }
      const before = commits;
      for (let i = 0; i < 20; i++) {
        fireEvent.scroll(grid());
        fireEvent.scroll(window);
        window.dispatchEvent(new Event("resize"));
        visual.dispatchEvent(new Event("scroll"));
        visual.dispatchEvent(new Event("resize"));
      }
      await frame();
      await frame();
      expect(commits).toBe(before);
      // A shorter screen (a phone on its side) still changes it.
      visual.height = 500;
      visual.dispatchEvent(new Event("resize"));
      await frame();
      expect(screen.getByTestId("expression-panel").style.getPropertyValue("--expression-height")).toBe("290px");
    } finally {
      Reflect.deleteProperty(window, "visualViewport");
    }
  });

  it("opens on emoji, with categories, a search field and the grid, and a switch at the bottom", async () => {
    const { user } = composer();
    await user.click(smiley());
    const panel = screen.getByTestId("expression-panel");
    expect(panel).toHaveAttribute("data-tab", "emoji");
    expect(smiley()).toHaveAttribute("aria-expanded", "true");
    expect(within(panel).getAllByRole("tab").map((t) => [t.getAttribute("aria-label"), t.getAttribute("aria-selected")])).toEqual([["Emoji", "true"], ["GIF", "false"]]);
    // No recent emoji yet: the categories start at smileys, which is underlined.
    const categories = within(panel).getByRole("toolbar", { name: "Emoji categories" });
    expect(within(categories).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(
      ["Smileys & people", "Animals & nature", "Food & drink", "Activities", "Travel & places", "Objects", "Symbols", "Flags"]);
    expect(screen.getByTestId("emoji-category-people")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByPlaceholderText("Search emoji")).toBeInTheDocument();
    expect(within(screen.getByTestId("emoji-section-people")).getByRole("button", { name: "😀" })).toBeInTheDocument();
  });

  it("puts an emoji where the caret is, keeps the panel open, and lists it first under Recent next time", async () => {
    const { user } = composer();
    await user.type(field(), "hi there");
    field().setSelectionRange(2, 2);
    await user.click(smiley());
    await user.click(within(screen.getByTestId("emoji-section-people")).getByRole("button", { name: "😀" }));
    expect(field()).toHaveValue("hi😀 there");
    expect(field().selectionStart).toBe(4);
    expect(screen.getByTestId("expression-panel")).toBeInTheDocument();
    await user.click(within(screen.getByTestId("emoji-section-nature")).getAllByRole("button")[0]);
    // Closed and opened again: the recent ones come first, the latest first.
    await user.click(smiley());
    expect(screen.queryByTestId("expression-panel")).not.toBeInTheDocument();
    await user.click(smiley());
    const recent = screen.getByTestId("emoji-section-recent");
    expect(within(recent).getAllByRole("button").map((b) => b.textContent)).toEqual([expect.any(String), "😀"]);
    expect(screen.getByTestId("emoji-category-recent")).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps recent emoji per profile", async () => {
    const first = composer();
    await first.user.click(smiley());
    await first.user.click(screen.getByRole("button", { name: "👍" }));
    first.unmount();
    setProfile("work");
    const other = composer();
    await other.user.click(smiley());
    expect(screen.queryByTestId("emoji-section-recent")).not.toBeInTheDocument();
    other.unmount();
    setProfile("");
    const back = composer();
    await back.user.click(smiley());
    expect(within(screen.getByTestId("emoji-section-recent")).getByRole("button", { name: "👍" })).toBeInTheDocument();
  });

  it("searches by name and keyword; Enter picks the first", async () => {
    const { user } = composer();
    await user.click(smiley());
    await user.type(screen.getByPlaceholderText("Search emoji"), "ghost");
    const results = screen.getByTestId("emoji-section-search");
    expect(within(results).getAllByRole("button")[0]).toHaveTextContent("👻");
    // Nothing is underlined while the search is shown.
    expect(screen.getByTestId("emoji-category-people")).toHaveAttribute("aria-pressed", "false");
    await user.keyboard("{Enter}");
    expect(field()).toHaveValue("👻");
    await user.clear(screen.getByPlaceholderText("Search emoji"));
    await user.type(screen.getByPlaceholderText("Search emoji"), "zzzqqq");
    expect(screen.getByText("No emoji found")).toBeInTheDocument();
    // A category clears the search and goes to it.
    await user.click(screen.getByTestId("emoji-category-foods"));
    expect(screen.getByPlaceholderText("Search emoji")).toHaveValue("");
    expect(screen.getByTestId("emoji-category-foods")).toHaveAttribute("aria-pressed", "true");
  });

  it("remembers the skin tone", async () => {
    const { user, unmount } = composer();
    await user.click(smiley());
    await user.click(screen.getByTestId("emoji-skin"));
    await user.click(screen.getByTestId("emoji-skin-3"));
    expect(screen.getByRole("button", { name: "👋🏽" })).toBeInTheDocument();
    unmount();
    const again = composer();
    await again.user.click(smiley());
    expect(screen.getByRole("button", { name: "👋🏽" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "👋" })).not.toBeInTheDocument();
  });

  it("has the skin tones as one Tab stop, the chosen tone; the arrows move and only Space or Enter chooses (and closes the row)", async () => {
    const { user } = composer();
    await user.click(smiley());
    await user.click(screen.getByTestId("emoji-skin"));
    const tones = within(screen.getByRole("radiogroup", { name: "Skin tone" })).getAllByRole("radio");
    const chosen = tones.findIndex(r => r.getAttribute("aria-checked") === "true");
    expect(tones.map(r => r.tabIndex)).toEqual(tones.map((_, i) => i === chosen ? 0 : -1));
    const other = (chosen + 1) % tones.length, last = tones[tones.length - 1];
    tones[chosen].focus();
    await user.keyboard("{ArrowRight}");
    expect(tones[other]).toHaveFocus();
    // Moving chooses nothing: the row stays open, the chosen tone as it was.
    expect(screen.getByTestId("emoji-skins")).toBeInTheDocument();
    expect(tones[chosen]).toHaveAttribute("aria-checked", "true");
    await user.keyboard("{End}");
    expect(last).toHaveFocus();
    await user.keyboard("{Home}");
    expect(tones[0]).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(last).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.queryByTestId("emoji-skins")).not.toBeInTheDocument();
    expect(screen.getByTestId("emoji-skin")).toHaveTextContent(last.textContent!);
  });

  it("moves through the grid with the arrow keys", async () => {
    const { user } = composer();
    await user.click(smiley());
    await user.click(screen.getByPlaceholderText("Search emoji"));
    await user.keyboard("{ArrowDown}");
    const cells = within(screen.getByTestId("emoji-grid")).getAllByRole("button");
    expect(cells[0]).toHaveFocus();
    expect(cells[0]).toHaveAttribute("tabindex", "0");
    await user.keyboard("{ArrowRight}");
    expect(cells[1]).toHaveFocus();
    // One tab stop: the cell left behind leaves the tab order.
    expect(cells[1]).toHaveAttribute("tabindex", "0");
    expect(cells[0]).toHaveAttribute("tabindex", "-1");
    await user.keyboard("{Enter}");
    expect(field()).toHaveValue(cells[1].textContent);
  });

  it("switches to GIFs, which it remembers, and sends the one chosen", async () => {
    const fetch = gifCities();
    const { user, unmount } = composer();
    await user.click(smiley());
    await user.click(screen.getByTestId("expression-tab-gif"));
    expect(screen.getByTestId("expression-panel")).toHaveAttribute("data-tab", "gif");
    expect(screen.getByTestId("expression-tab-gif")).toHaveAttribute("aria-selected", "true");
    // Ghosts first: GifCities has no trending.
    expect(await screen.findAllByTestId("gif-result")).toHaveLength(3);
    expect(String(fetch.mock.calls[0][0])).toContain("q=ghost");
    expect(screen.getByTestId("gif-category-ghosts")).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByTestId("gif-category-love"));
    await waitFor(() => expect(String(fetch.mock.lastCall![0])).toContain("q=love"));
    expect(screen.getByTestId("gif-category-love")).toHaveAttribute("aria-pressed", "true");
    await user.type(screen.getByPlaceholderText("Search GIFs"), "dancing baby");
    await waitFor(() => expect(String(fetch.mock.lastCall![0])).toContain("q=dancing%20baby"), { timeout: 2000 });
    expect(screen.getByTestId("gif-category-love")).toHaveAttribute("aria-pressed", "false");
    await waitFor(() => expect(screen.getAllByTestId("gif-result")[0]).toHaveAttribute("title", "dancing baby 0"));
    await user.click(screen.getAllByTestId("gif-result")[0]);
    expect(onSend).toHaveBeenCalledWith("https://web.archive.org/web/http://geocities.com/dancing_baby0.gif");
    await waitFor(() => expect(screen.queryByTestId("expression-panel")).not.toBeInTheDocument());
    unmount();
    const again = composer();
    await again.user.click(smiley());
    expect(screen.getByTestId("expression-panel")).toHaveAttribute("data-tab", "gif");
  });

  it("says when GIF search is down, and tries again on request", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("Unavailable", { status: 503 }));
    localStorage.setItem("ghostly_composer_panel_tab", "gif");
    const { user } = composer();
    await user.click(smiley());
    expect(await screen.findByText("GIF search is unavailable.")).toBeInTheDocument();
    expect(screen.queryByTestId("gif-loading")).not.toBeInTheDocument();
    gifCities();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findAllByTestId("gif-result")).toHaveLength(3);
    expect(screen.queryByTestId("gif-trouble")).not.toBeInTheDocument();
  });

  /** GifCities that answers only when the test says so, per search. */
  function slowGifCities() {
    const answers = new Map<string, () => void>();
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation((input) => new Promise((resolve) => {
      const q = new URL(String(input)).searchParams.get("q")!;
      answers.set(q, () => resolve(new Response(JSON.stringify([{ gif: `http://geocities.com/${q.replace(/\s/g, "_")}.gif`, url_text: `${q} gif`, checksum: q }]))));
    }));
    const answer = (q: string) => act(() => { answers.get(q)!(); });
    return { fetch, answer, asked: (q: string) => waitFor(() => expect(answers.has(q)).toBe(true)) };
  }

  it("each category is a search of its own: a spinner until its answer is in, never the last category's tiles", async () => {
    const gifCities = slowGifCities();
    localStorage.setItem("ghostly_composer_panel_tab", "gif");
    const { user } = composer();
    await user.click(smiley());
    await gifCities.asked("ghost");
    expect(screen.getByTestId("gif-loading")).toBeInTheDocument();
    await gifCities.answer("ghost");
    expect(await screen.findByTitle("ghost gif")).toBeInTheDocument();
    const categories = [["retro", "computer"], ["happy", "happy"], ["sad", "sad"], ["love", "love"], ["yes", "thumbs up"], ["party", "party"], ["animals", "cat"]];
    for (const [id, q] of categories) {
      await user.click(screen.getByTestId(`gif-category-${id}`));
      expect(screen.getByTestId(`gif-category-${id}`)).toHaveAttribute("aria-pressed", "true");
      // GifCities takes seconds: meanwhile the grid is a spinner, not the tiles of the category before.
      expect(screen.queryAllByTestId("gif-result")).toHaveLength(0);
      expect(screen.getByTestId("gif-loading")).toBeInTheDocument();
      await gifCities.asked(q);
      expect(new URL(String(gifCities.fetch.mock.lastCall![0])).searchParams.get("q")).toBe(q);
      await gifCities.answer(q);
      expect(await screen.findByTitle(`${q} gif`)).toBeInTheDocument();
      expect(screen.getByTestId("gif-grid")).toHaveAttribute("data-query", q);
      expect(screen.getAllByTestId("gif-result")).toHaveLength(1);
    }
    // An answer seen once is back at once, with no second search.
    const searches = gifCities.fetch.mock.calls.length;
    await user.click(screen.getByTestId("gif-category-ghosts"));
    expect(screen.getByTitle("ghost gif")).toBeInTheDocument();
    expect(gifCities.fetch.mock.calls.length).toBe(searches);
  });

  it("shows the category chosen last, whichever answer comes first", async () => {
    const gifCities = slowGifCities();
    localStorage.setItem("ghostly_composer_panel_tab", "gif");
    const { user } = composer();
    await user.click(smiley());
    await gifCities.asked("ghost");
    await gifCities.answer("ghost");
    await screen.findByTitle("ghost gif");
    await user.click(screen.getByTestId("gif-category-happy"));
    await gifCities.asked("happy");
    await user.click(screen.getByTestId("gif-category-sad"));
    await gifCities.asked("sad");
    // The answer to the category left behind is not shown for the one chosen.
    await gifCities.answer("happy");
    expect(screen.getByTestId("gif-loading")).toBeInTheDocument();
    expect(screen.queryByTitle("happy gif")).not.toBeInTheDocument();
    await gifCities.answer("sad");
    expect(await screen.findByTitle("sad gif")).toBeInTheDocument();
    expect(screen.getByTestId("gif-grid")).toHaveAttribute("data-query", "sad");
  });

  it("says so when none of a search's previews load, and draws them again on request", async () => {
    gifCities(2);
    localStorage.setItem("ghostly_composer_panel_tab", "gif");
    const { user } = composer();
    await user.click(smiley());
    const tiles = await screen.findAllByTestId("gif-result");
    // The Wayback Machine lost the first: the tile goes, the rest stay.
    fireEvent.error(within(tiles[0]).getByRole("img"));
    expect(screen.getAllByTestId("gif-result")).toHaveLength(1);
    // All lost: not a blank grid, but a word about it.
    fireEvent.error(within(screen.getByTestId("gif-result")).getByRole("img"));
    expect(screen.getByTestId("gif-trouble")).toHaveTextContent("The GIFs could not be loaded.");
    expect(screen.queryByTestId("gif-grid")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findAllByTestId("gif-result")).toHaveLength(2);
  });

  it("closes on Escape, giving the focus back to the message", async () => {
    const { user } = composer();
    await user.click(smiley());
    await user.click(screen.getByPlaceholderText("Search emoji"));
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("expression-panel")).not.toBeInTheDocument();
    expect(field()).toHaveFocus();
  });

  it("opened from the keyboard, takes the focus on its search, the arrows reach the grid, and Escape gives it back to the button", async () => {
    const { user } = composer();
    smiley().focus();
    await user.keyboard("{Enter}");
    expect(screen.getByPlaceholderText("Search emoji")).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(within(screen.getByTestId("emoji-section-people")).getByRole("button", { name: "😀" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("expression-panel")).not.toBeInTheDocument();
    expect(smiley()).toHaveFocus();
    // With Space too; opened by a click, the focus stays where it was.
    await user.keyboard(" ");
    expect(screen.getByPlaceholderText("Search emoji")).toHaveFocus();
    await user.keyboard("{Escape}");
    await user.click(smiley());
    expect(smiley()).toHaveFocus();
  });

  // A browser focuses nothing `visibility: hidden` hides, and the panel is hidden for its first draw, until it is placed.
  // Its search took the focus only while the emoji were still loading (the first open); every later one left it on the button.
  it("gives its search the focus once it is placed, not while its first draw is still hidden", async () => {
    const real = HTMLElement.prototype.focus;
    const whileHidden: string[] = [];
    const spy = vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (this: HTMLElement, options?: FocusOptions) {
      if (this.closest<HTMLElement>("[data-testid='expression-panel']")?.style.visibility === "hidden") whileHidden.push(this.getAttribute("placeholder") ?? this.tagName);
      real.call(this, options);
    });
    try {
      gifCities();
      const { user } = composer();
      for (const key of ["{Enter}", " "]) {
        smiley().focus();
        await user.keyboard(key);
        expect(screen.getByPlaceholderText("Search emoji")).toHaveFocus();
        await user.keyboard("{Escape}");
      }
      // The GIF tab's search takes the focus on every open.
      localStorage.setItem("ghostly_composer_panel_tab", "gif");
      await user.click(smiley());
      expect(await screen.findByTestId("expression-panel")).toHaveAttribute("data-tab", "gif");
      expect(whileHidden).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it("the + and the panel take turns", async () => {
    const { user } = composer();
    await user.click(smiley());
    await user.click(plus());
    expect(screen.queryByTestId("expression-panel")).not.toBeInTheDocument();
    expect(screen.getByTestId("composer-menu")).toBeInTheDocument();
    await user.click(smiley());
    expect(screen.queryByTestId("composer-menu")).not.toBeInTheDocument();
    expect(screen.getByTestId("expression-panel")).toBeInTheDocument();
  });

  it("is a sheet on a phone; picking does not bring the keyboard up, and the backdrop closes it", async () => {
    viewport(390, 844);
    const { user } = composer();
    await user.click(smiley());
    const panel = screen.getByTestId("expression-panel");
    expect(panel.className).toMatch(/\bsheet\b/);
    await user.click(screen.getByRole("button", { name: "😀" }));
    expect(field()).toHaveValue("😀");
    expect(field()).not.toHaveFocus();
    const backdrop = document.querySelector(".sheet-backdrop")!;
    act(() => { backdrop.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); backdrop.dispatchEvent(new PointerEvent("pointerup", { bubbles: true })); });
    expect(screen.queryByTestId("expression-panel")).not.toBeInTheDocument();
  });

  it("on a phone, the click a tap on the backdrop leaves behind reaches nothing under it", async () => {
    viewport(390, 844);
    const { user } = composer();
    await user.click(smiley());
    const backdrop = document.querySelector(".sheet-backdrop")!;
    const tap = { bubbles: true, pointerType: "touch" };
    act(() => { backdrop.dispatchEvent(new PointerEvent("pointerdown", tap)); backdrop.dispatchEvent(new PointerEvent("pointerup", tap)); });
    expect(screen.queryByTestId("expression-panel")).not.toBeInTheDocument();
    // The screen's click comes after the backdrop is gone, where the tap was: here the + beside the field.
    const more = screen.getByTestId("composer-more");
    act(() => { more.click(); });
    expect(screen.queryByTestId("composer-menu")).not.toBeInTheDocument();
    // The next tap is the person's own.
    act(() => { more.click(); });
    expect(screen.getByTestId("composer-menu")).toBeInTheDocument();
  });

  it("stays inside the chat's column", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      // A narrow chat column, 300px wide, starting 400px in; the composer 60px tall at the bottom.
      const box = this.hasAttribute("data-composer") ? { left: 400, right: 700, top: 700, bottom: 760 } : { left: 0, right: 0, top: 0, bottom: 0 };
      return { ...box, x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top, toJSON: () => box } as DOMRect;
    });
    const { user } = composer();
    await user.click(smiley());
    const panel = screen.getByTestId("expression-panel");
    expect(parseFloat(panel.style.left)).toBe(408);
    expect(parseFloat(panel.style.width)).toBe(284);
    expect(parseFloat(panel.style.top) + parseFloat(panel.style.height)).toBe(692);
    fireEvent.scroll(window);
  });
});

describe("GIF search while the Internet Archive says to wait", () => {
  const searched = (fetch: { mock: { calls: unknown[][] } }) => fetch.mock.calls.map(([input]) => new URL(String(input)).searchParams.get("q"));

  it("says search is busy and counts the wait down; Try again stays off until it is over, and nothing asks by itself", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => rateLimitPage());
    localStorage.setItem("ghostly_composer_panel_tab", "gif");
    const { user } = composer();
    await user.click(smiley());
    const busy = await screen.findByTestId("gif-busy");
    expect(busy).toHaveTextContent("GIF search is busy right now.");
    // Not "unavailable": the page came with a 200, and it is not JSON.
    expect(screen.queryByTestId("gif-trouble")).not.toBeInTheDocument();
    const wait = screen.getByTestId("gif-busy-wait");
    const retry = screen.getByRole("button", { name: "Try again" });
    expect(wait).toHaveTextContent("Try again in 0:30.");
    expect(retry).toBeDisabled();
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(wait).toHaveTextContent("Try again in 0:20.");
    expect(retry).toBeDisabled();
    act(() => { vi.advanceTimersByTime(20_000); });
    expect(wait).toHaveTextContent("You can try again now.");
    expect(retry).toBeEnabled();
    expect(fetch).toHaveBeenCalledTimes(1);
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(fetch).toHaveBeenCalledTimes(1);
    // The person asks; this time GifCities answers.
    gifCities();
    await user.click(retry);
    expect(await screen.findAllByTestId("gif-result")).toHaveLength(3);
    expect(screen.queryByTestId("gif-busy")).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("waits longer each time it is told to wait again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => rateLimitPage());
    localStorage.setItem("ghostly_composer_panel_tab", "gif");
    const { user } = composer();
    await user.click(smiley());
    expect(await screen.findByTestId("gif-busy-wait")).toHaveTextContent("Try again in 0:30.");
    act(() => { vi.advanceTimersByTime(30_000); });
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByTestId("gif-busy-wait")).toHaveTextContent("Try again in 1:00."));
    expect(screen.getByRole("button", { name: "Try again" })).toBeDisabled();
  });

  it("counts the wait down from the moment it is on screen", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => rateLimitPage());
    localStorage.setItem("ghostly_composer_panel_tab", "gif");
    // The very moment the wait shows, before the page has a chance to do anything else: what a loaded runner sees.
    const shown = new Promise<void>((resolve) => {
      const watch = new MutationObserver(() => { if (screen.queryByTestId("gif-busy-wait")) { watch.disconnect(); resolve(); } });
      watch.observe(document.body, { childList: true, subtree: true });
    });
    const { user } = composer();
    await user.click(smiley());
    await shown;
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(screen.getByTestId("gif-busy-wait")).toHaveTextContent("Try again in 0:20.");
    act(() => { vi.advanceTimersByTime(20_000); });
    expect(screen.getByTestId("gif-busy-wait")).toHaveTextContent("You can try again now.");
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  });

  it("keeps the wait across categories and panels, shows the GIFs it has, and asks nothing meanwhile", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const q = new URL(String(input)).searchParams.get("q")!;
      return q === "ghost" ? new Response(JSON.stringify([{ gif: "http://geocities.com/ghost.gif", url_text: "ghost gif", checksum: "ghost" }])) : rateLimitPage();
    });
    localStorage.setItem("ghostly_composer_panel_tab", "gif");
    const { user } = composer();
    await user.click(smiley());
    expect(await screen.findByTitle("ghost gif")).toBeInTheDocument();
    await user.click(screen.getByTestId("gif-category-happy"));
    expect(await screen.findByTestId("gif-busy")).toHaveTextContent("GIF search is busy right now.");
    // The GIFs it has from earlier, said to be so, still to be sent.
    expect(screen.getByTestId("gif-earlier")).toHaveTextContent("Showing earlier results.");
    expect(screen.getByTestId("gif-grid")).toHaveAttribute("data-earlier", "true");
    expect(screen.getByTestId("gif-grid")).toHaveAttribute("data-query", "ghost");
    expect(screen.queryByTestId("gif-emoji-instead")).not.toBeInTheDocument();
    await user.click(screen.getByTitle("ghost gif"));
    expect(onSend).toHaveBeenCalledWith("https://web.archive.org/web/http://geocities.com/ghost.gif");
    expect(searched(fetch)).toEqual(["ghost", "happy"]);

    // Another panel, the same wait: ghosts are kept, the rest waits, and nothing is asked.
    await user.click(smiley());
    expect(screen.getByTitle("ghost gif")).toBeInTheDocument();
    expect(screen.queryByTestId("gif-busy")).not.toBeInTheDocument();
    for (const id of ["sad", "party", "happy"]) {
      await user.click(screen.getByTestId(`gif-category-${id}`));
      expect(screen.getByTestId("gif-busy")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Try again" })).toBeDisabled();
    }
    await user.type(screen.getByPlaceholderText("Search GIFs"), "banshee");
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(screen.getByTestId("gif-busy")).toBeInTheDocument();
    expect(searched(fetch)).toEqual(["ghost", "happy"]);
  });

  it("reads a request that fails as a network error does as busy while online (the limit page has no CORS header), and as unavailable offline", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Load failed"));
    localStorage.setItem("ghostly_composer_panel_tab", "gif");
    const first = composer();
    await first.user.click(smiley());
    expect(await screen.findByTestId("gif-busy")).toHaveTextContent("GIF search is busy right now.");
    expect(screen.getByRole("button", { name: "Try again" })).toBeDisabled();
    first.unmount();
    resetGifSearch();
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const second = composer();
    await second.user.click(smiley());
    expect(await screen.findByText("GIF search is unavailable.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  });

  it("offers the emoji when it has no GIFs to show", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("", { status: 429 }));
    localStorage.setItem("ghostly_composer_panel_tab", "gif");
    const { user } = composer();
    await user.click(smiley());
    await user.click(await screen.findByRole("button", { name: "Pick an emoji instead" }));
    expect(screen.getByTestId("expression-panel")).toHaveAttribute("data-tab", "emoji");
    expect(screen.getByPlaceholderText("Search emoji")).toBeInTheDocument();
  });

  it("uses the answers it has when the panel opens again or a category comes back: no second search", async () => {
    const fetch = gifCities();
    localStorage.setItem("ghostly_composer_panel_tab", "gif");
    const { user } = composer();
    await user.click(smiley());
    await screen.findByTitle("ghost 0");
    await user.click(screen.getByTestId("gif-category-love"));
    await screen.findByTitle("love 0");
    await user.click(screen.getByTestId("gif-category-ghosts"));
    expect(screen.getByTitle("ghost 0")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await user.click(smiley());
    expect(screen.getByTitle("ghost 0")).toBeInTheDocument();
    expect(screen.queryByTestId("gif-loading")).not.toBeInTheDocument();
    expect(searched(fetch)).toEqual(["ghost", "love"]);
  });

  it("asks nothing for a category passed on the way to another", async () => {
    const fetch = gifCities();
    localStorage.setItem("ghostly_composer_panel_tab", "gif");
    const { user } = composer();
    await user.click(smiley());
    await screen.findByTitle("ghost 0");
    // Clicked in a row, as a person looking for the right icon does.
    for (const id of ["happy", "sad", "love"]) fireEvent.click(screen.getByTestId(`gif-category-${id}`));
    await screen.findByTitle("love 0");
    expect(searched(fetch)).toEqual(["ghost", "love"]);
  });

  it("speaks the app's language", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => rateLimitPage());
    localStorage.setItem("ghostly_composer_panel_tab", "gif");
    const { user } = renderApp(<LockScreenProvider><MessageInput onSend={onSend} /></LockScreenProvider>, { language: "pt" });
    await user.click(smiley());
    expect(await screen.findByTestId("gif-busy")).toHaveTextContent("A busca de GIFs está ocupada agora.");
    expect(screen.getByTestId("gif-busy-wait")).toHaveTextContent("Tente de novo em 0:30.");
  });
});

// covers: chat.paired.send
describe("the composer counts a message's bytes", () => {
  /**
   * A chat's message is at most 16 KiB of UTF-8 (the engine's limit), not 16,384 characters. Seen 2026-10-08 on dev: a
   * paired chat's field took 16,300 "é" (32,600 bytes), its counter said 84 left, and Send came back with the engine's
   * English "Message exceeds 16384 UTF-8 bytes." in every language.
   */
  const onSend = vi.fn(async (_text: string) => null as string | null);
  afterEach(() => { onSend.mockClear(); localStorage.clear(); sessionStorage.clear(); setProfile(""); });

  function composer(extra: Partial<Parameters<typeof MessageInput>[0]> = {}) {
    return renderApp(<LockScreenProvider><MessageInput draftId="bytes" onSend={onSend} maxLength={16_384} textBytes={16_384} {...extra} /></LockScreenProvider>);
  }
  const field = () => screen.getByPlaceholderText<HTMLTextAreaElement>("Message…");

  it("a text under 16,384 characters but over 16 KiB stays in the field with why, and nothing is sent", async () => {
    composer();
    fireEvent.change(field(), { target: { value: "é".repeat(16_300) } });
    // Over the limit, the count says so: not the 84 characters left.
    expect(screen.getByTestId("composer-left")).toHaveTextContent("-16216 B");
    await act(async () => { fireEvent.keyDown(field(), { key: "Enter" }); });
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("That is too long to send (32,600 bytes, the limit is 16,384). Shorten it, or send it as a file.");
    expect(field().value).toHaveLength(16_300);
  });

  it("emoji count four bytes each: 4,096 go, one more does not", async () => {
    composer();
    fireEvent.change(field(), { target: { value: "👻".repeat(4_097) } });
    await act(async () => { fireEvent.keyDown(field(), { key: "Enter" }); });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.change(field(), { target: { value: "👻".repeat(4_096) } });
    expect(screen.getByTestId("composer-left")).toHaveTextContent("0 B");
    await act(async () => { fireEvent.keyDown(field(), { key: "Enter" }); });
    expect(onSend).toHaveBeenCalledWith("👻".repeat(4_096));
  });

  it("off the live link, the DHT's count turns amber where the packet stops carrying a text, not only past 256 B", () => {
    // Its envelope takes about 8 of the 256 bytes once sealed: a 252 B text read "252 / 256 B" in muted ink, then the
    // DHT refused it (or kept it for live) as one past 256 B.
    composer({ softBytes: 256 });
    fireEvent.change(field(), { target: { value: "x".repeat(248) } });
    expect(screen.getByTestId("dht-byte-count")).toHaveClass("text-text-muted");
    expect(screen.getByTestId("dht-byte-count")).not.toHaveAttribute("title");
    fireEvent.change(field(), { target: { value: "x".repeat(252) } });
    expect(screen.getByTestId("dht-byte-count")).toHaveTextContent("252 / 256 B");
    expect(screen.getByTestId("dht-byte-count")).toHaveClass("text-warn-ink");
    expect(screen.getByTestId("dht-byte-count")).toHaveAttribute("title", "About 248 bytes fit the DHT once sealed: shorten it to send it there");
  });

  it("the count's warning reaches the field and is said once as it changes, not only as a mouse tooltip", () => {
    // Its sentence was a `title` on a span no keyboard reaches: a screen reader typing on heard nothing as the count
    // turned amber at about 248 B, nor past 256 B, where the text silently waits for live.
    composer({ softBytes: 256 });
    const live = () => screen.getByTestId("composer-count-said");
    fireEvent.change(field(), { target: { value: "x".repeat(240) } });
    expect(field()).not.toHaveAccessibleDescription();
    expect(live()).toHaveTextContent("");
    fireEvent.change(field(), { target: { value: "x".repeat(252) } });
    expect(field()).toHaveAccessibleDescription("About 248 bytes fit the DHT once sealed: shorten it to send it there");
    expect(live()).toHaveTextContent("About 248 bytes fit the DHT once sealed: shorten it to send it there");
    fireEvent.change(field(), { target: { value: "x".repeat(300) } });
    expect(field()).toHaveAccessibleDescription("Over the 256 bytes the DHT carries: it is sent when you are live");
    expect(live()).toHaveTextContent("Over the 256 bytes the DHT carries: it is sent when you are live");
    // Each keystroke within a state says nothing new.
    live().textContent = "";
    fireEvent.change(field(), { target: { value: "x".repeat(301) } });
    expect(live()).toHaveTextContent("");
    fireEvent.change(field(), { target: { value: "x".repeat(10) } });
    expect(field()).not.toHaveAccessibleDescription();
  });

  it("the 16 KiB count's warning, red under 50 left and past the limit, reaches the field too", () => {
    composer();
    const live = () => screen.getByTestId("composer-count-said");
    fireEvent.change(field(), { target: { value: "x".repeat(16_350) } });
    expect(field()).toHaveAccessibleDescription("Bytes left: 34");
    expect(live()).toHaveTextContent("Bytes left: 34");
    fireEvent.change(field(), { target: { value: "é".repeat(8_200) } });
    expect(field()).toHaveAccessibleDescription("That is too long to send (16,400 bytes, the limit is 16,384). Shorten it, or send it as a file.");
  });

  it("off the live link, past 16 KiB the hard count shows instead of the DHT's", () => {
    composer({ softBytes: 256 });
    fireEvent.change(field(), { target: { value: "x".repeat(300) } });
    expect(screen.getByTestId("dht-byte-count")).toHaveTextContent("300 / 256 B");
    fireEvent.change(field(), { target: { value: "é".repeat(8_200) } });
    expect(screen.queryByTestId("dht-byte-count")).toBeNull();
    expect(screen.getByTestId("composer-left")).toHaveTextContent("-16 B");
  });
});

// covers: app.i18n
/**
 * The message field and a file's caption read a draft in its own direction, as its bubble will: from its first letter
 * (`dir="auto"`). Empty or with no letter yet they keep the app's, so the placeholder and a lone emoji stay where the app
 * writes. The direction a browser draws: e2e/web/text-direction.spec.ts.
 */
describe("the message field's direction", () => {
  const field = () => screen.getByPlaceholderText<HTMLTextAreaElement>("Message…");
  const type = (text: string) => fireEvent.change(field(), { target: { value: text } });

  it("follows the draft's first letter, and the app's while there is none", () => {
    renderApp(<LockScreenProvider><MessageInput onSend={vi.fn(async () => null)} /></LockScreenProvider>);
    expect(field()).not.toHaveAttribute("dir");
    type("👍 2");
    expect(field()).not.toHaveAttribute("dir");
    type("draft kept?");
    expect(field()).toHaveAttribute("dir", "auto");
    type("مرحبا يا صديقي!");
    expect(field()).toHaveAttribute("dir", "auto");
    type("");
    expect(field()).not.toHaveAttribute("dir");
  });

  it("the caption of a file being sent does the same", async () => {
    URL.createObjectURL = vi.fn(() => "blob:file");
    URL.revokeObjectURL = vi.fn();
    renderApp(<LockScreenProvider><MessageInput onSend={vi.fn(async () => null)} onSendFile={vi.fn(async () => null)} /></LockScreenProvider>);
    const file = new File(["notes"], "notes.txt", { type: "text/plain" });
    fireEvent.paste(field(), { clipboardData: { files: [file], types: ["Files"], items: [{ kind: "file", type: file.type, getAsFile: () => file }], getData: () => "" } });
    const caption = await screen.findByTestId("attachment-caption");
    expect(caption).not.toHaveAttribute("dir");
    fireEvent.change(caption, { target: { value: "notes for Sunday?" } });
    expect(caption).toHaveAttribute("dir", "auto");
    fireEvent.change(caption, { target: { value: "🙂" } });
    expect(caption).not.toHaveAttribute("dir");
  });
});

// covers: chat.paired.send
describe("the composer's caret while a send disables it", () => {
  const onSend = vi.fn<(text: string) => Promise<string | null>>(async () => null);
  const composer = (disabled: boolean) => <LockScreenProvider><MessageInput draftId="focus-test" onSend={onSend} disabled={disabled} /></LockScreenProvider>;
  /** A wrapper that stays the same across rerenders (renderApp's is new each time, which would mount a new composer). */
  const Providers = ({ children }: { children: ReactNode }) => <AppProviders>{children}</AppProviders>;
  const renderApp = (ui: React.ReactElement) => ({ ...render(ui, { wrapper: Providers }), user: userEvent.setup() });
  const field = () => screen.getByPlaceholderText<HTMLTextAreaElement>("Message…");

  /**
   * What Chrome and WebKit do to a focused field that turns disabled: they take its focus away, to the body. happy-dom
   * keeps it (and ignores blur() on a disabled field), so the test lets go of it for them.
   */
  const browserDropsFocus = () => act(() => {
    const input = field();
    expect(input).toBeDisabled();
    input.disabled = false; input.blur(); input.disabled = true;
  });

  afterEach(() => { localStorage.clear(); setProfile(""); });

  it("comes back to the field once it is enabled again", async () => {
    const { rerender } = renderApp(composer(false));
    expect(field()).toHaveFocus();
    rerender(composer(true));
    browserDropsFocus();
    expect(field()).not.toHaveFocus();
    rerender(composer(false));
    expect(field()).toHaveFocus();
  });

  it("stays where the person put it meanwhile", async () => {
    const { rerender, user } = renderApp(<>{composer(false)}<button type="button">elsewhere</button></>);
    rerender(<>{composer(true)}<button type="button">elsewhere</button></>);
    browserDropsFocus();
    await user.click(screen.getByRole("button", { name: "elsewhere" }));
    rerender(<>{composer(false)}<button type="button">elsewhere</button></>);
    expect(screen.getByRole("button", { name: "elsewhere" })).toHaveFocus();
  });

  it("is not taken when the field did not have it", async () => {
    const { rerender } = renderApp(<>{composer(false)}<button type="button">elsewhere</button></>);
    screen.getByRole("button", { name: "elsewhere" }).focus();
    rerender(<>{composer(true)}<button type="button">elsewhere</button></>);
    act(() => { (document.activeElement as HTMLElement).blur(); });
    rerender(<>{composer(false)}<button type="button">elsewhere</button></>);
    expect(field()).not.toHaveFocus();
  });
});

// covers: app.accessibility, app.theme
describe("the composer in forced colors", () => {
  /**
   * Forced colors (Windows Contrast themes) drop box shadows and replace backgrounds with the page's: the composer's
   * field, edged by an inset shadow on its fill, read as loose text, and the round Send / mic button lost its shape.
   * In forced colors only, the field (and the voice bar in its place) gets an outline, the round buttons a ButtonText
   * border. What the browser draws is e2e/web/forced-colors-controls.spec.ts.
   */
  const CSS = readFileSync(join(fileURLToPath(import.meta.url), "../../../components/composer/composer.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const FORCED = "@media (forced-colors: active)";

  /** The rules inside `@media (forced-colors: active)` blocks (selector -> declarations), and the stylesheet without them. */
  function forced(): { rules: Map<string, Record<string, string>>; rest: string } {
    const rules = new Map<string, Record<string, string>>();
    let rest = "", at = 0;
    for (let start = CSS.indexOf(FORCED); start >= 0; start = CSS.indexOf(FORCED, at)) {
      const open = CSS.indexOf("{", start);
      let depth = 1, i = open + 1;
      for (; depth > 0; i++) depth += CSS[i] === "{" ? 1 : CSS[i] === "}" ? -1 : 0;
      rest += CSS.slice(at, start);
      for (const [, selectors, body] of CSS.slice(open + 1, i - 1).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const decls: Record<string, string> = {};
        for (const [, name, value] of body.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)) decls[name] = value.trim();
        for (const selector of selectors.split(",")) rules.set(selector.trim(), decls);
      }
      at = i;
    }
    return { rules, rest: rest + CSS.slice(at) };
  }

  describe("the composer's field in forced colors (composer.css)", () => {
    it("the field and the voice bar in its place keep a CanvasText edge, drawn inside them, so nothing moves", () => {
      const { rules } = forced();
      for (const selector of [".composer-field", ".composer-row > .voice-bar"]) {
        expect(rules.get(selector), `${selector} inside ${FORCED}`).toMatchObject({ outline: "1px solid CanvasText", "outline-offset": "-1px" });
      }
    });

    it("the focused field's ring still wins over that edge", () => {
      // `.composer-field:has(.composer-textarea:focus-visible)` is more specific than `.composer-field`, wherever it stands.
      expect(forced().rest).toMatch(/\.composer-field:has\(\.composer-textarea:focus-visible\)\s*\{[^}]*outline:\s*2px solid/);
    });
  });

  const FORCED_EDGE = ["forced-colors:border", "forced-colors:border-[color:ButtonText]"];

  describe("the round Send and mic buttons in forced colors", () => {
    beforeEach(() => { installFakeMedia(); installFakeAudio(); });
    afterEach(() => removeFakeMedia());

    it("the mic, then Send once there is a message, carry a ButtonText border", () => {
      renderApp(<MessageInput onSend={async () => null} onSendFile={async () => null} />);
      const mic = screen.getByTestId("voice-record");
      for (const c of FORCED_EDGE) expect(mic, "the mic").toHaveClass(c);
      fireEvent.change(screen.getByPlaceholderText("Message…"), { target: { value: "hi" } });
      const send = screen.getByRole("button", { name: "Send message" });
      for (const c of FORCED_EDGE) expect(send, "Send").toHaveClass(c);
    });

    it("Send, in a chat that sends no files", () => {
      renderApp(<MessageInput onSend={async () => null} />);
      const send = screen.getByRole("button", { name: "Send message" });
      for (const c of FORCED_EDGE) expect(send).toHaveClass(c);
    });
  });
});

// covers: chat.paired.send
describe("a refusal above the composer", () => {
  /** What a group answers a file it paces, and a text over 16 KiB, in the languages slowest to read. */
  const PACED_JA = "このグループに短時間で多くのファイルを送りました。3分待ってから、もう一度送ってください。";
  const TOO_LONG_ZH = "内容过长，无法发送（18,000 字节，上限为 16,384）。请缩短，或作为文件发送。";
  const PACED_AR = "أرسلت ملفات كثيرة إلى هذه المجموعة للتو. انتظر 3 دقائق، ثم أرسله مرة أخرى.";
  const SHORT_EN = "Could not send the file.";

  /** The mean silent reading speed (IReST, characters a minute, spaces not counted): how long a line takes to read. */
  const readMs = (text: string, perMinute: number) => [...text.replace(/\s/g, "")].length / perMinute * 60_000;

  const sendRefused = async (refusal: string, language: Language) => {
    renderApp(<LockScreenProvider><MessageInput draftId={`hold-${language}`} onSend={async () => null} onSendFile={async () => refusal} /></LockScreenProvider>, { language });
    fireEvent.change(screen.getByTestId("file-input"), { target: { files: [new File(["x"], "a.txt", { type: "text/plain" })] } });
    return screen.findByRole("alert");
  };
  const card = () => screen.queryByText(/./, { selector: "[role='alert'] span" });
  const wait = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

  afterEach(() => { vi.useRealTimers(); localStorage.clear(); });

  it.each([["ja", PACED_JA, 357], ["zh", TOO_LONG_ZH, 255], ["ar", PACED_AR, 612]] as const)(
    "in %s stays up at least as long as it takes to read, then goes by itself", async (language, refusal, perMinute) => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      await sendRefused(refusal, language);
      expect(card()).toHaveTextContent(refusal);
      wait(Math.max(5_200, readMs(refusal, perMinute)));
      expect(card()).toHaveTextContent(refusal);
      wait(30_000);
      expect(card()).toBeNull();
    });

  it("a short English line still goes after 5 s", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await sendRefused(SHORT_EN, "en");
    wait(4_800);
    expect(card()).toHaveTextContent(SHORT_EN);
    wait(400);
    expect(card()).toBeNull();
  });

  it("stays while it is pointed at, and goes once the pointer leaves", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const alert = await sendRefused(PACED_JA, "ja");
    fireEvent.pointerEnter(alert.firstElementChild!);
    wait(60_000);
    expect(card()).toHaveTextContent(PACED_JA);
    fireEvent.pointerLeave(alert.firstElementChild!);
    wait(30_000);
    expect(card()).toBeNull();
  });

  it("stays while its × has the focus; closed, it hands the focus to the message field", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const alert = await sendRefused(PACED_JA, "ja");
    const close = within(alert).getByRole("button");
    act(() => close.focus());
    wait(60_000);
    expect(card()).toHaveTextContent(PACED_JA);
    expect(close).toHaveFocus();
    fireEvent.click(close);
    expect(card()).toBeNull();
    expect(screen.getByRole("textbox")).toHaveFocus();
    expect(document.activeElement).not.toBe(document.body);
  });

  it("gives its × a 32 x 32 px tap target, as the app's other card does", async () => {
    const alert = await sendRefused(SHORT_EN, "en");
    expect(within(alert).getByRole("button", { name: "Close" })).toHaveClass("grid", "h-8", "w-8", "place-items-center");
  });

  it("goes by itself once the focus has left its ×", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const alert = await sendRefused(PACED_JA, "ja");
    const close = within(alert).getByRole("button");
    act(() => close.focus());
    wait(60_000);
    act(() => screen.getByRole("textbox").focus());
    wait(30_000);
    expect(card()).toBeNull();
    expect(screen.getByRole("textbox")).toHaveFocus();
  });
});

// covers: app.composer.paste-files, app.mobile-layout
describe("Send files on a phone", () => {
  /**
   * On a phone, Send files (files pasted, dropped or shared into a chat) gives a thumb 44 × 44 px where a tap lands, as
   * the rest of the app does: each file's × was 28 × 28 px and Cancel / Send 40 px tall. The × carry `.tap-target`
   * (index.css), which grows where a tap lands past the box without moving the tile; Cancel and Send are 44 px tall under
   * the phone breakpoint. The measure itself is a browser's (e2e/web/phone-touch-targets.spec.ts).
   */
  const INDEX_CSS = readFileSync(join(fileURLToPath(import.meta.url), "../../../index.css"), "utf8");

  /** A 1 x 1 PNG's header: the sheet draws a picture only once its header says its size. */
  const PNG = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0];

  function pasteFiles(files: File[]) {
    renderApp(<MessageInput onSend={vi.fn().mockResolvedValue(null)} onSendFile={vi.fn().mockResolvedValue(null)} />);
    fireEvent.paste(screen.getByPlaceholderText("Message…"), {
      clipboardData: { files, types: ["Files"], items: files.map((file) => ({ kind: "file", type: file.type, getAsFile: () => file })), getData: () => "" },
    });
    return screen.findByTestId("attachment-sheet");
  }

  const picture = () => new File([new Uint8Array(PNG)], "IMG_0042.png", { type: "image/png" });
  const notes = (i: number) => new File([new Uint8Array(100 * i)], `notes-${i}.txt`, { type: "text/plain" });

  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => "blob:picture");
    URL.revokeObjectURL = vi.fn();
  });

  it("a picture and three files: each × is thumb-sized, and its tile does not clip that larger area", async () => {
    const sheet = await pasteFiles([picture(), notes(1), notes(2), notes(3)]);
    await within(sheet).findByRole("img", { name: "IMG_0042.png" });
    const removers = within(sheet).getAllByRole("button", { name: /^Remove / });
    expect(removers.map((button) => button.getAttribute("aria-label"))).toEqual(["Remove IMG_0042.png", "Remove notes-1.txt", "Remove notes-2.txt", "Remove notes-3.txt"]);
    for (const button of removers) {
      expect(button, button.getAttribute("aria-label")!).toHaveClass("tap-target", "absolute");
      const tile = button.closest("li")!;
      expect(tile.className, button.getAttribute("aria-label")!).not.toMatch(/\boverflow-/);
      // The sizes overflow-hidden gave the grid stay: the tiles neither grow with their content nor move.
      expect(tile).toHaveClass("aspect-square", "min-w-0", "min-h-0");
    }
  });

  it("Cancel and Send are 44 px tall, with one file or several", async () => {
    const several = await pasteFiles([picture(), notes(1)]);
    for (const id of ["attachment-cancel", "attachment-send"]) expect(within(several).getByTestId(id), id).toHaveClass("max-md:min-h-11");
    fireEvent.click(within(several).getByTestId("attachment-cancel"));
    expect(screen.queryByTestId("attachment-sheet")).toBeNull();
  });

  it("one file alone: Cancel and Send are 44 px tall too", async () => {
    const one = await pasteFiles([notes(1)]);
    for (const id of ["attachment-cancel", "attachment-send"]) expect(within(one).getByTestId(id), id).toHaveClass("max-md:min-h-11");
  });

  it("a .tap-target placed with absolute stays where it is: the phone rule makes only the others relative", () => {
    const phone = INDEX_CSS.match(/@media \(width < 768px\) \{\n((?: {2}[^\n]*\n)*?\s*\.tap-target::after[^\n]*\n)\}/)?.[1] ?? "";
    expect(phone).toMatch(/\.tap-target::after \{/);
    expect(phone).toMatch(/\.tap-target:not\(\.absolute\) \{ position: relative; \}/);
    expect(phone).not.toMatch(/\.tap-target \{[^}]*position/);
  });
});
