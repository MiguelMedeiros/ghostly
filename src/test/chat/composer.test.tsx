import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageInput } from "../../components/MessageInput";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { setStorageProfile as setProfile } from "../../lib/storage";
import { renderApp } from "../render";

// covers: app.composer.attach, app.composer.expressions, app.emoji-picker, chat.paired.emoji, chat.paired.gifs, chat.paired.gifs.categories

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

beforeEach(() => {
  onSend.mockReset().mockResolvedValue(null);
  onSendFile.mockReset().mockResolvedValue(null);
});
afterEach(() => {
  viewport(1024, 768);
  Reflect.deleteProperty(navigator, "mediaDevices");
  setProfile("");
  vi.restoreAllMocks();
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
