import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MessageBubble } from "../../components/MessageBubble";
import { forgetPictureLinks } from "../../lib/pictureLink";
import { publicKeyLabel } from "../../lib/publicKeyLabel";
import { servicesPlatform } from "../../lib/platform";
import type { ChatMessage } from "../../lib/types";
import { fakeEngine, linkView } from "../fakeEngine";
import { REGTEST_INVOICE } from "../payments/fixtures";
import { renderApp } from "../render";

// covers: chat.paired.links, chat.paired.image-links, chat.paired.receipts, chat.paired.delete-message, chat.paired.message-details, chat.paired.join-notice, payments.lightning.invoice-card, payments.cashu.token-card, chat.waiting

// A real bolt11 for 21u (2,100 sat), from packages/browser/test/uiHelpers.test.ts.
const INVOICE = "lnbc21u1p42mkf2dqqpp56q3d9mfahf0974jqwy0yyfrg7zxksgxk7ufcc084yydhfx43daqqsp59g4z52329g4z52329g4z52329g4z52329g4z52329g4z52329g4q9qrsgqcqzyskhkhqar4dqgqfmarvdttr8x2nrp4txtamfupfftrnn4hmrp7s8ayen7hp2ye58jq8zu65rch9eplpxkhf3pf2nvuynhqxvkw5f7a2vgq486x8x";
const TOKEN = "cashuB" + "o".repeat(40);
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
/** The first bytes of a picture of this size, as each kind's header says it. */
const heads = {
  png: (w: number, h: number) => [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, w >>> 24, (w >>> 16) & 255, (w >>> 8) & 255, w & 255, h >>> 24, (h >>> 16) & 255, (h >>> 8) & 255, h & 255, 8, 6, 0, 0, 0],
  jpeg: (w: number, h: number) => [0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3],
  gif: (w: number, h: number) => [...new TextEncoder().encode("GIF89a"), w & 255, w >> 8, h & 255, h >> 8, 0, 0, 0],
  webp: (w: number, h: number) => [...new TextEncoder().encode("RIFF"), 22, 0, 0, 0, ...new TextEncoder().encode("WEBPVP8X"), 10, 0, 0, 0, 0, 0, 0, 0,
    (w - 1) & 255, ((w - 1) >> 8) & 255, (w - 1) >> 16, (h - 1) & 255, ((h - 1) >> 8) & 255, (h - 1) >> 16],
};
const inline = (kind: keyof typeof heads, w: number, h: number) =>
  `data:image/${kind};base64,${btoa(String.fromCharCode(...heads[kind](w, h)))}`;

/** An old message (history: no entry animation) from the contact, unless the patch says otherwise. */
const message = (patch: Partial<ChatMessage> = {}): ChatMessage => ({ id: "m1", text: "hello", sender: "peer", timestamp: 1_700_000_000_000, ...patch });

function bubble(patch: Partial<ChatMessage> = {}, props: Partial<Parameters<typeof MessageBubble>[0]> = {}) {
  return renderApp(<MessageBubble message={message(patch)} peerPubKey="peer" {...props} />);
}

const image = (container: HTMLElement) => container.querySelector("img");

describe("MessageBubble: pictures", () => {
  beforeEach(() => forgetPictureLinks());

  it.each([
    ["an inline PNG", PNG],
    ["an inline JPEG", inline("jpeg", 640, 480)],
    ["an inline GIF", "data:image/gif;base64,R0lGODlhAQABAAAAACw="],
    ["an inline WebP", inline("webp", 320, 240)],
    ["an inline picture as large as a 50 MP photo", inline("png", 8160, 6120)],
    ["a Giphy GIF", "https://media2.giphy.com/media/xT9IgG50Fb7Mi0prBC/giphy.gif"],
    ["a Giphy picture without an image extension", "https://media.giphy.com/media/abc123/200w"],
  ])("loads %s from the contact by itself", (_, url) => {
    const { container } = bubble({ text: url });
    expect(image(container)).toHaveAttribute("src", url);
    expect(screen.queryByTestId("image-reveal")).not.toBeInTheDocument();
  });

  it.each([
    ["a PNG", inline("png", 23000, 23000)],
    ["a GIF", inline("gif", 65535, 65535)],
    ["a JPEG", inline("jpeg", 60000, 60000)],
    ["a WebP", inline("webp", 16383, 16383)],
    ["a picture wider than a panorama", inline("png", 40000, 10)],
  ])("does not draw an inline %s whose header declares more pixels than a picture file may have", (_, url) => {
    // About 90 characters that would take gigabytes once decoded, on every receiver's page as the bubble is drawn.
    const { container } = bubble({ text: url });
    expect(image(container)).toBeNull();
    expect(screen.queryByTestId("image-reveal")).not.toBeInTheDocument();
    expect(screen.getByText(url)).toBeInTheDocument();
  });

  it.each([
    ["a JPEG with no frame header", "data:image/jpeg;base64,/9j/4AAQSkZJRg=="],
    ["a WebP with no size", "data:image/webp;base64,UklGRhoAAABXRUJQ"],
    ["bytes of no kind it reads", `data:image/png;base64,${btoa("BM6\0\0\0\0\0\0\0")}`],
    ["data that is not base64", "data:image/png,%89PNG%0D%0A%1A%0A"],
    ["base64 that does not decode", "data:image/png;base64,%69VBORw0KGgo"],
  ])("does not draw an inline picture whose size its bytes do not say: %s", (_, url) => {
    const { container } = bubble({ text: url });
    expect(image(container)).toBeNull();
    expect(screen.getByText(url)).toBeInTheDocument();
  });

  it.each([
    ["a capture with a timestamp", "https://web.archive.org/web/20091027000000/http://www.geocities.com/area51/dancing.gif"],
    ["a capture with no timestamp (as the picker sends it)", "https://web.archive.org/web/http://geocities.com/ghost/0.gif"],
    ["an image capture (im_)", "https://web.archive.org/web/20091027000000im_/http://www.geocities.com/area51/dancing.gif"],
  ])("reads %s from the Wayback Machine by itself, and draws it as pixel art", async (_, url) => {
    const fetched = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(new Uint8Array(heads.gif(88, 31)) as BodyInit, { status: 200 }));
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => "blob:http://localhost/gif-1");
    const { container } = bubble({ text: url });
    expect(screen.queryByTestId("image-reveal")).not.toBeInTheDocument();
    // Anyone can have the archive keep a GIF: its bytes are read and checked, never handed to an <img> as they are.
    expect(fetched).toHaveBeenCalledWith(url, expect.anything());
    expect(await screen.findByTestId("picture-link")).toHaveAttribute("src", "blob:http://localhost/gif-1");
    expect(image(container)!.getAttribute("style")).toContain("pixelated");
  });

  it("draws a Wayback Machine GIF in its own box before it decodes, and at once when its chat opens again", async () => {
    const url = "https://web.archive.org/web/http://geocities.com/ghost/1.gif";
    const fetched = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(new Uint8Array(heads.gif(320, 240)) as BodyInit, { status: 200 }));
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => "blob:http://localhost/gif-2");
    const first = bubble({ text: url });
    const drawn = await screen.findByTestId("picture-link");
    // The box its bytes say, before the picture decodes: nothing under it moves when it does (happy-dom keeps no
    // min()/max() width, so only its ratio is seen here).
    expect(drawn.style.aspectRatio).toBe("320 / 240");
    first.unmount();
    // Drawn again (a chat opened again, a row scrolled back): the picture is there in the first frame, read once.
    const { container } = bubble({ text: url });
    expect(screen.queryByTestId("picture-link-reading")).not.toBeInTheDocument();
    expect(image(container)).toHaveAttribute("src", "blob:http://localhost/gif-2");
    expect(image(container)!.style.aspectRatio).toBe("320 / 240");
    expect(fetched).toHaveBeenCalledTimes(1);
  });

  it("falls back to the link for a Wayback Machine GIF whose header declares too many pixels", async () => {
    const url = "https://web.archive.org/web/20091027000000/http://www.geocities.com/area51/huge.gif";
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(new Uint8Array(heads.gif(65535, 65535)) as BodyInit, { status: 200 }));
    const { container } = bubble({ text: url });
    expect(await screen.findByRole("link", { name: url })).toHaveAttribute("href", url);
    expect(image(container)).toBeNull();
  });

  it.each([
    ["a path that climbs out of /web/", "https://web.archive.org/web/../../save/http://example.com/x.gif"],
    ["an encoded climb", "https://web.archive.org/web/%2e%2e/%2e%2e/save/x.gif"],
    ["a query", "https://web.archive.org/web/20091027000000/http://www.geocities.com/a.gif?track=1"],
    ["a query on the capture's own URL", "https://web.archive.org/web/http://example.com/pixel?id=1&x.gif"],
    ["another path of the archive", "https://web.archive.org/save/http://example.com/x.gif"],
    ["a path with no archived URL", "https://web.archive.org/web/20091027000000/x.gif"],
    ["a port", "https://web.archive.org:8443/web/http://geocities.com/x.gif"],
    ["credentials", "https://user@web.archive.org/web/http://geocities.com/x.gif"],
    ["another host", "https://web.archive.org.example.com/web/http://geocities.com/x.gif"],
  ])("keeps %s on web.archive.org behind a click", (_, url) => {
    const { container } = bubble({ text: url });
    expect(image(container)).toBeNull();
    expect(screen.getByTestId("image-reveal")).toBeInTheDocument();
  });

  it("does not draw an ordinary picture as pixel art", () => {
    const { container } = bubble({ text: PNG });
    expect(image(container)!.getAttribute("style") ?? "").not.toContain("pixelated");
  });

  it("keeps any other picture from the contact behind a click, naming its host", async () => {
    const url = "https://cdn.example.com/photos/cat.jpg?size=large";
    const { user, container } = bubble({ text: url });
    // Loading it would tell cdn.example.com this device's address.
    expect(image(container)).toBeNull();
    const reveal = screen.getByTestId("image-reveal");
    expect(reveal).toHaveTextContent("Show picture · cdn.example.com");
    // Asked for: the app reads it, and the page never names the contact's address in an <img>.
    const fetched = vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));
    await user.click(reveal);
    expect(fetched).toHaveBeenCalledWith(url, expect.anything());
    expect(image(container)).toBeNull();
    expect(screen.getByTestId("picture-link-reading")).toBeInTheDocument();
    expect(screen.queryByTestId("image-reveal")).not.toBeInTheDocument();
  });

  it("reads my own pictures from anywhere, with no click", () => {
    const fetched = vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));
    const url = "https://cdn.example.com/photos/cat.png";
    bubble({ text: url, sender: "me" });
    expect(fetched).toHaveBeenCalledWith(url, expect.anything());
    expect(screen.queryByTestId("image-reveal")).not.toBeInTheDocument();
  });

  it("treats an SVG data URL as text, never as a picture", () => {
    const svg = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=";
    const { container } = bubble({ text: svg, sender: "me" });
    expect(image(container)).toBeNull();
    expect(screen.getByText(svg)).toBeInTheDocument();
  });

  it("treats a picture over plain http as a link", () => {
    const url = "http://example.com/cat.png";
    const { container } = bubble({ text: url });
    expect(image(container)).toBeNull();
    expect(screen.queryByTestId("image-reveal")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: url })).toHaveAttribute("href", url);
  });

  it("falls back to the text when a picture does not load", () => {
    const url = "https://media.giphy.com/media/gone/giphy.gif";
    const { container } = bubble({ text: url });
    fireEvent.error(image(container)!);
    expect(image(container)).toBeNull();
    expect(screen.getByRole("link", { name: url })).toHaveAttribute("href", url);
  });
});

/**
 * A browser draws an `<img>` only from an address the shell's Content-Security-Policy lets load, and each shell has
 * its own. The test builds have none (`vite preview` sends no header, happy-dom loads nothing), so only reading the
 * policies tells whether the picture a bubble shows can be seen in a real app.
 */
describe("MessageBubble: a picture link under each shell's img-src", () => {
  const root = (path: string) => readFileSync(join(import.meta.dirname, "../../../../..", path), "utf8");
  const policies: Record<string, () => string> = {
    web: () => /Content-Security-Policy "([^"]+)"/.exec(root("apps/web/nginx-headers.conf"))![1]!,
    extension: () => (JSON.parse(root("apps/extension/public/manifest.json")) as { content_security_policy: { extension_pages: string } }).content_security_policy.extension_pages,
    desktop: () => (JSON.parse(root("apps/desktop/tauri.conf.json")) as { app: { security: { csp: string } } }).app.security.csp,
  };
  /** Whether `policy` lets an `<img>` load `src`: a scheme it names (`data:`, `blob:`), or the origin of a host it names. */
  const loads = (policy: string, src: string) => {
    const sources = policy.split(";").map(part => part.trim().split(/\s+/)).find(([name]) => name === "img-src")?.slice(1) ?? [];
    return sources.some(source => (source.endsWith(":") ? src.startsWith(source) : source.startsWith("https://") && new URL(src).origin === source));
  };
  const PNG_BYTES = Uint8Array.from(atob(PNG.slice(PNG.indexOf(",") + 1)), c => c.charCodeAt(0));
  const answer = (bytes: Uint8Array, type = "image/png") => new Response(bytes as BodyInit, { status: 200, headers: { "content-type": type } });

  beforeEach(() => {
    forgetPictureLinks();
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => "blob:http://localhost/picture-1");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  });

  it("reads the policies as a browser does", () => {
    expect(loads("default-src 'self'; img-src 'self' data: blob: https://media.giphy.com", "blob:http://localhost/1")).toBe(true);
    expect(loads("default-src 'self'; img-src 'self' data: blob: https://media.giphy.com", "https://media.giphy.com/media/a/giphy.gif")).toBe(true);
    expect(loads("default-src 'self'; img-src 'self' data: blob: https://media.giphy.com", "https://cdn.example.com/cat.png")).toBe(false);
  });

  it.each(Object.keys(policies))("%s: the picture shown after Show picture is one its policy lets load", async (shell) => {
    const fetched = vi.spyOn(globalThis, "fetch").mockImplementation(async () => answer(PNG_BYTES));
    const url = "https://cdn.example.com/photos/cat.png";
    const { user } = bubble({ text: url });
    expect(fetched).not.toHaveBeenCalled();
    await user.click(screen.getByTestId("image-reveal"));
    const src = (await screen.findByTestId("picture-link")).getAttribute("src")!;
    expect(loads(policies[shell]!(), src), `${shell} img-src lets ${src} load`).toBe(true);
    // The site is asked once, with no cookies and no referrer.
    expect(fetched).toHaveBeenCalledTimes(1);
    expect(fetched.mock.calls[0]![0]).toBe(url);
    expect(fetched.mock.calls[0]![1]).toMatchObject({ credentials: "omit", referrerPolicy: "no-referrer" });
  });

  it.each(Object.keys(policies))("%s: my own picture link shows a picture its policy lets load", async (shell) => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => answer(PNG_BYTES));
    bubble({ text: "https://cdn.example.com/photos/cat.png", sender: "me" });
    const src = (await screen.findByTestId("picture-link")).getAttribute("src")!;
    expect(loads(policies[shell]!(), src), `${shell} img-src lets ${src} load`).toBe(true);
  });

  it.each(Object.keys(policies))("%s: the pictures that show by themselves are ones its policy lets load", (shell) => {
    for (const url of [PNG, "https://media2.giphy.com/media/xT9IgG50Fb7Mi0prBC/giphy.gif"]) {
      const { container, unmount } = bubble({ text: url });
      expect(loads(policies[shell]!(), image(container)!.getAttribute("src")!), `${shell} img-src lets ${url.slice(0, 40)} load`).toBe(true);
      unmount();
    }
  });

  it.each([
    ["the site cannot be read (no CORS header, or it is down)", async () => { throw new TypeError("Failed to fetch"); }],
    ["the site answers 404", async () => new Response("", { status: 404 })],
    ["what comes is not a picture, whatever the site calls it", async () => answer(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"), "image/png")],
    ["what comes declares more pixels than a picture file may have", async () => answer(new Uint8Array(heads.png(23000, 23000)))],
    ["what comes does not say its size", async () => answer(new Uint8Array(heads.jpeg(640, 480).slice(0, 4)), "image/jpeg")],
  ])("falls back to the address as a link when %s", async (_, respond) => {
    vi.spyOn(globalThis, "fetch").mockImplementation(respond);
    const url = "https://cdn.example.com/photos/cat.png";
    const { user, container } = bubble({ text: url });
    await user.click(screen.getByTestId("image-reveal"));
    expect(await screen.findByRole("link", { name: url })).toHaveAttribute("href", url);
    expect(image(container)).toBeNull();
  });

  it("never asks an address on this machine or the local network", async () => {
    const fetched = vi.spyOn(globalThis, "fetch").mockImplementation(async () => answer(PNG_BYTES));
    const url = "https://192.168.1.1/cat.png";
    const { user } = bubble({ text: url });
    await user.click(screen.getByTestId("image-reveal"));
    expect(await screen.findByRole("link", { name: url })).toBeInTheDocument();
    expect(fetched).not.toHaveBeenCalled();
  });
});

describe("MessageBubble: money in a message", () => {
  it("shows a Lightning invoice as a card to pay", () => {
    bubble({ text: INVOICE });
    const card = screen.getByTestId("invoice-bubble");
    expect(card).toHaveTextContent("Lightning invoice");
    expect(within(card).getByTestId("money-amount")).toHaveTextContent("2,100");
  });

  it("lays out an invoice's memo by its own direction, and keeps its amount and unit in one isolated run", () => {
    // In Arabic the card's lines took the page's direction: "1 cup coffee" read "cup coffee 1", and "sats" was glued to
    // the number. The memo is whoever made the invoice's text, in any script, as a message's text is.
    bubble({ text: REGTEST_INVOICE });
    const card = screen.getByTestId("invoice-bubble");
    expect(within(card).getByText("1 cup coffee")).toHaveAttribute("dir", "auto");
    const amount = within(card).getByTestId("money-amount");
    expect(amount.parentElement!.tagName).toBe("BDI");
    expect(amount.parentElement!.lastElementChild).toHaveTextContent(/sats/);
  });

  it("keeps the words around an invoice above its card", () => {
    bubble({ text: `pay me please ${INVOICE}` });
    expect(screen.getByText("pay me please")).toBeInTheDocument();
    expect(screen.getByTestId("invoice-bubble")).toBeInTheDocument();
  });

  it("shows an ecash token as a card, once the wallet read it", async () => {
    fakeEngine.on("walletInspectCashu", () => ({ inspection: { kind: "token", amount: 100, unit: "sat", mint: "https://mint.example.com", accepted: true } }));
    const { engine } = bubble({ text: `here you go ${TOKEN}` });
    const card = await screen.findByTestId("cashu-token-bubble");
    expect(card).toHaveTextContent("Mint: mint.example.com");
    expect(engine.callsTo("walletInspectCashu")).toEqual([{ text: TOKEN }]);
  });

  it("keeps the card of a token too long for a QR, with Redeem and Copy", async () => {
    // 11 proofs with their DLEQ come to about 3,300 characters, past the 2,953 bytes one QR code holds.
    const big = "cashuB" + "o".repeat(3300);
    fakeEngine.on("walletInspectCashu", () => ({ inspection: { kind: "token", amount: 2047, unit: "sat", mint: "https://mint.example.com", accepted: true } }));
    bubble({ text: `here you go ${big}` });
    const card = await screen.findByTestId("cashu-token-bubble");
    expect(screen.queryByTestId("message-unshowable")).not.toBeInTheDocument();
    expect(within(card).getByTestId("token-redeem")).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Copy" })).toBeInTheDocument();
    expect(within(card).getByTestId("qr-too-long")).toHaveTextContent("Too long for a QR code");
    expect(card.querySelector("svg")).toBeNull();
  });

  it("shows an ecash token of another unit as one this wallet cannot take", async () => {
    // 500 usd is $5.00 (the unit's cents): never a bolt and a raw 500, and nothing to redeem.
    fakeEngine.on("walletInspectCashu", () => ({ inspection: { kind: "token", amount: 500, unit: "usd", mint: "https://mint.example.com", accepted: false } }));
    bubble({ text: TOKEN });
    const card = await screen.findByTestId("cashu-token-bubble");
    expect(card).toHaveTextContent("A usd token");
    expect(card).toHaveTextContent("Only sat ecash can be redeemed here.");
    expect(card).not.toHaveTextContent("⚡");
    expect(card).not.toHaveTextContent("You have not added this mint");
    expect(within(card).queryByTestId("money-amount")).not.toBeInTheDocument();
    expect(within(card).queryByTestId("token-redeem")).not.toBeInTheDocument();
  });

  it("leaves a payment's text to its payment bubble", () => {
    bubble({ text: INVOICE, paymentId: "pay-9" });
    expect(screen.queryByTestId("invoice-bubble")).not.toBeInTheDocument();
    // No such payment in the wallet: the bubble falls back to the text it carried.
    expect(screen.getByText(INVOICE)).toBeInTheDocument();
  });

  it("leaves a file's caption alone", () => {
    // Still arriving: the bubble does not look for the bytes yet.
    fakeEngine.update({ transfers: { "file-1": { state: "transferring", transferred: 5, size: 10 } } });
    bubble({ text: INVOICE, file: { id: "file-1", name: "invoice.txt", size: 10, mime: "text/plain" } });
    expect(screen.getByTestId("file-bubble")).toHaveTextContent("invoice.txt");
    expect(screen.queryByTestId("invoice-bubble")).not.toBeInTheDocument();
  });
});

describe("MessageBubble: text", () => {
  it("turns web addresses into links that open apart from the app", () => {
    bubble({ text: "docs at https://ghostly.tools/docs and http://example.org/a?b=1 too" });
    for (const href of ["https://ghostly.tools/docs", "http://example.org/a?b=1"]) {
      const link = screen.getByRole("link", { name: href });
      expect(link).toHaveAttribute("href", href);
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
    }
    expect(screen.getByText(/docs at/)).toHaveTextContent("docs at https://ghostly.tools/docs and http://example.org/a?b=1 too");
  });

  it("shows a message of only emoji big", () => {
    bubble({ text: "🎉👻" });
    expect(screen.getByText("🎉👻")).toHaveClass("text-[42px]");
  });

  it.each([["words with an emoji", "nice 🎉"], ["too many emoji", "🎉🎉🎉🎉🎉🎉🎉"]])("shows %s at the normal size", (_, text) => {
    bubble({ text });
    expect(screen.getByText(text)).not.toHaveClass("text-[42px]");
  });

  it("names the contact on their messages, from the message or the chat", () => {
    const { rerender } = bubble({ text: "hi", nick: "Alice" }, { peerNick: "Bob" });
    expect(screen.getByText("~Alice")).toBeInTheDocument();
    rerender(<MessageBubble message={message({ text: "hi" })} peerNick="Bob" />);
    expect(screen.getByText("~Bob")).toBeInTheDocument();
    rerender(<MessageBubble message={message({ text: "hi", sender: "me" })} peerNick="Bob" />);
    expect(screen.queryByText("~Bob")).not.toBeInTheDocument();
  });

  it("opens the message's details on a double click, and Escape closes them", async () => {
    const { user } = bubble({ text: "hi", sender: "me", meta: { dhtKey: "k".repeat(40), encryptedPayloadLength: 10, dnsRecords: ["a", "b"] } }, { peerAck: 1_800_000_000_000 });
    await user.dblClick(screen.getByText("hi"));
    const panel = await screen.findByTestId("message-details");
    expect(within(panel).getByTestId("message-details-kind")).toHaveTextContent("Text");
    expect(screen.getByTestId("message-details-keys-hint")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("message-details")).not.toBeInTheDocument();
  });
});

describe("MessageBubble: system lines", () => {
  it("says a contact with no name joined the chat by a short key", () => {
    const key = "yb1q3k9mfahf0974jqwy0yyfrg7zxksgxk7ufcc0";
    bubble({ sender: "system", text: "", systemEvent: { type: "join", pubKey: key } }, { peerPubKey: key });
    expect(screen.getByText(publicKeyLabel(key))).toBeInTheDocument();
    expect(screen.getByText(/joined the chat/)).toBeInTheDocument();
  });

  it("names the contact who joined as the chat names them, the key kept in the tooltip", () => {
    const key = "yb1q3k9mfahf0974jqwy0yyfrg7zxksgxk7ufcc0";
    bubble({ sender: "system", text: "👋 Ali joined", nick: "Ali", systemEvent: { type: "join", pubKey: key } }, { peerPubKey: key, peerNick: "Alice" });
    const line = screen.getByTestId("join-line");
    expect(line).toHaveTextContent(/^Alice joined the chat/);
    expect(line).not.toHaveTextContent(publicKeyLabel(key));
    expect(line).toHaveAttribute("title", key);
  });

  it("says my own join as mine, not as a stranger's key", () => {
    const mine = "gdqtg9aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa6i5b6y";
    bubble({ sender: "system", text: "👋 Bob joined", nick: "Bob", systemEvent: { type: "join", pubKey: mine } }, { peerPubKey: "yb1q3k9mfahf0974jqwy0yyfrg7zxksgxk7ufcc0", peerNick: "Alice" });
    expect(screen.getByTestId("join-line")).toHaveTextContent(/^You joined the chat/);
    expect(screen.queryByText(publicKeyLabel(mine))).not.toBeInTheDocument();
  });

  it.each([
    ["call_missed", "Missed audio call", true],
    ["call_rejected", "Audio call declined", true],
    ["call_failed", "Audio call couldn't connect", true],
    ["call_unanswered", "Audio call, no answer", true],
    ["call_cancelled", "Audio call cancelled", false],
    ["call_ended", "Audio call ended", false],
    ["call_received", "Incoming audio call", false],
  ] as const)("marks a %s event as missed or not", (type, text, missed) => {
    bubble({ sender: "system", text, callEvent: { type } });
    const pill = screen.getByText(text).parentElement!;
    expect(pill.classList.contains("bg-danger/10")).toBe(missed);
  });

  it.each([[65_000, "(1 min 5 s)"], [42_900, "(42 s)"], [600_000, "(10 min 0 s)"], [3_780_000, "(1 h 3 min)"]])("shows a call that lasted %i ms as %s", (duration, shown) => {
    bubble({ sender: "system", text: "Call ended", callEvent: { type: "call_ended", duration } });
    expect(screen.getByText(shown)).toBeInTheDocument();
  });

  it.each([["ja", "(1 分 5 秒)"], ["zh", "(1 分 5 秒)"], ["ar", "(1 دقيقة 5 ثانية)"], ["pt", "(1 min 5 s)"]] as const)("says a call's length in %s", (language, shown) => {
    renderApp(<MessageBubble message={message({ sender: "system", text: "Audio call ended", callEvent: { type: "call_ended", duration: 65_000 } })} peerPubKey="peer" />, { language });
    expect(screen.getByText(shown)).toBeInTheDocument();
  });

  it("shows no length for a call that never started", () => {
    bubble({ sender: "system", text: "Missed audio call", callEvent: { type: "call_missed", duration: 0 } });
    expect(screen.getByText("Missed audio call").parentElement).not.toHaveTextContent("(");
  });

  it("shows no length for a call ended within its first second, rather than (0 s)", () => {
    bubble({ sender: "system", text: "Audio call ended", callEvent: { type: "call_ended", duration: 400 } });
    expect(screen.getByText("Audio call ended").parentElement).not.toHaveTextContent("(");
  });

  it("lets a system line be deleted too, from its menu", async () => {
    const { user } = bubble({ sender: "system", text: "Call ended", callEvent: { type: "call_ended" } }, { onDelete: () => {} });
    await user.click(screen.getByTestId("message-options"));
    expect(screen.getByRole("button", { name: "Delete message" })).toBeInTheDocument();
  });
});

describe("MessageBubble: delivery", () => {
  const mark = () => screen.getByTestId("message-delivery");

  it.each([
    ["sending", "Sending", "On its way."],
    ["queued", "Sending", "No receipt yet. Sends again by itself."],
    ["waiting", "Waiting for your contact to be online", "Sends by itself when your contact is online."],
    ["held", "Waiting for your contact to be online", "Kept for your contact until they are online."],
    ["sent", "Sent", "Sent. No receipt yet."],
    ["delivered", "Delivered", "Your contact's app received it."],
  ] as const)("marks a %s message beside the time as %s, and hovered says %s", async (delivery, label, hint) => {
    const { user, container } = bubble({ sender: "me", delivery });
    expect(mark()).toHaveAttribute("data-delivery", delivery);
    expect(mark()).toHaveAccessibleName(label);
    // In the time row, not a line of its own.
    expect(mark().closest(".msg-meta")).not.toBeNull();
    expect(container).not.toHaveTextContent(label);
    await user.hover(mark());
    expect(screen.getByRole("tooltip")).toHaveTextContent(hint);
    expect(mark()).toHaveAccessibleDescription(hint);
    await user.unhover(mark());
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it.each(["waiting", "sending", "queued"] as const)("with this device offline, a %s message says it waits for this device, not the contact", async (delivery) => {
    // Bug hunt r10a (2026-10-06): texts written offline said "Waiting for your contact to be online".
    const onLine = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    try {
      const { user } = bubble({ sender: "me", delivery });
      expect(mark()).toHaveAccessibleName("You are offline");
      await user.hover(mark());
      expect(screen.getByRole("tooltip")).toHaveTextContent("Sends by itself when you are back online.");
      onLine.mockReturnValue(true);
      act(() => { window.dispatchEvent(new Event("online")); });
      expect(mark()).not.toHaveAccessibleName("You are offline");
    } finally { onLine.mockRestore(); }
  });

  it("with this device offline, a message the contact's hold keeps still waits for the contact", () => {
    const onLine = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    try {
      bubble({ sender: "me", delivery: "held" });
      expect(mark()).toHaveAccessibleName("Waiting for your contact to be online");
    } finally { onLine.mockRestore(); }
  });

  it("puts no text line under the bubble and none of the engine's words, whatever the state", () => {
    for (const [delivery, deliveryError] of [["waiting", "Sent when you are live."], ["failed", "The contact's app is closed"], ["queued", "Connection closed before receipt."]] as const) {
      const { container, unmount } = bubble({ sender: "me", delivery, deliveryError });
      expect(container).not.toHaveTextContent(deliveryError);
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
      unmount();
    }
  });

  describe("a file waiting in a DHT-only chat", () => {
    const file = { id: "link-1-out-f", name: "report.pdf", size: 10, mime: "application/pdf" };
    const waitingFile = { sender: "me", text: "report.pdf", file, delivery: "waiting" } as const;
    const ONLINE = "Waiting for your contact to be online";
    const LIVE = "Waiting for a live connection";
    const dhtOnly = (delivery: ReturnType<typeof linkView>["dhtDelivery"]) => delivery;
    beforeEach(() => { vi.spyOn(servicesPlatform!, "getFile").mockResolvedValue(null); });

    it.each([
      ["I chose DHT only", { deliveryMode: "dht" }, "Files need a live connection. This chat is on DHT only: change it from the connection icon."],
      ["the contact chose DHT only", { textDelivery: "dht", dhtDelivery: dhtOnly({ mode: "stream", peerMode: "dht", authenticated: true, maxTextBytes: 256 }) }, "Files need a live connection. Your contact's chat is on DHT only: it goes when they allow live again."],
      // Both chose it: mine is said, the one that can be changed here.
      ["both chose DHT only", { deliveryMode: "dht", dhtDelivery: dhtOnly({ mode: "dht", peerMode: "dht", authenticated: true, maxTextBytes: 256 }) }, "Files need a live connection. This chat is on DHT only: change it from the connection icon."],
    ] as const)("waits for a live connection, not for the contact, when %s", async (_, link, hint) => {
      const { user, engine } = bubble(waitingFile);
      // The chat's mode comes with the engine's state: before it, the mark says what it always said.
      expect(mark()).toHaveAccessibleName(ONLINE);
      act(() => engine.update({ links: [linkView({ ...link })] }));
      expect(mark()).toHaveAttribute("data-delivery", "waiting");
      expect(mark()).toHaveAccessibleName(LIVE);
      await user.hover(mark());
      expect(screen.getByRole("tooltip")).toHaveTextContent(hint);
      expect(screen.getByRole("tooltip").textContent).not.toMatch(/online|—/);
    });

    it("waits for the contact again once the chat leaves DHT only", () => {
      const { engine } = bubble(waitingFile);
      act(() => engine.update({ links: [linkView({ deliveryMode: "dht" })] }));
      expect(mark()).toHaveAccessibleName(LIVE);
      act(() => engine.update({ links: [linkView({ deliveryMode: "stream" })] }));
      expect(mark()).toHaveAccessibleName(ONLINE);
    });

    it("says the contact chose it only while the header does: the chat's texts go through the DHT", () => {
      const { engine } = bubble(waitingFile);
      const theirs = dhtOnly({ mode: "stream", peerMode: "dht", authenticated: true, maxTextBytes: 256 });
      act(() => engine.update({ links: [linkView({ textDelivery: "hold", dhtDelivery: theirs })] }));
      expect(mark()).toHaveAccessibleName(ONLINE);
      act(() => engine.update({ links: [linkView({ textDelivery: "dht", dhtDelivery: theirs })] }));
      expect(mark()).toHaveAccessibleName(LIVE);
    });

    it("says so of a file only, and only while it waits", () => {
      const { engine, rerender } = bubble({ sender: "me", text: "a long text", delivery: "waiting" });
      act(() => engine.update({ links: [linkView({ deliveryMode: "dht" })] }));
      // A text too long for the DHT keeps its own words.
      expect(mark()).toHaveAccessibleName(ONLINE);
      rerender(<MessageBubble message={message({ ...waitingFile, delivery: "sending" })} peerPubKey="peer" />);
      expect(mark()).toHaveAccessibleName("Sending");
    });

    it("says it in the chat's language", async () => {
      const { user, engine } = renderApp(<MessageBubble message={message(waitingFile)} peerPubKey="peer" />, { language: "pt" });
      act(() => engine.update({ links: [linkView({ deliveryMode: "dht" })] }));
      expect(mark()).toHaveAccessibleName("Aguardando uma conexão direta");
      await user.hover(mark());
      expect(screen.getByRole("tooltip")).toHaveTextContent("Esta conversa está em Só DHT");
    });
  });

  it("says nothing about delivery on the contact's messages", () => {
    bubble({ delivery: "failed" });
    expect(screen.queryByTestId("message-delivery")).not.toBeInTheDocument();
  });

  it("a tap shows the line on a phone, and a finger held on the mark does not open the details", async () => {
    vi.useFakeTimers();
    try {
      bubble({ sender: "me", delivery: "waiting" });
      fireEvent.pointerDown(mark(), { pointerType: "touch", button: 0 });
      act(() => { vi.advanceTimersByTime(600); });
      expect(screen.getByRole("tooltip")).toHaveTextContent("Sends by itself when your contact is online.");
      expect(document.querySelector("[data-details-open]")).toBeNull();
      fireEvent.pointerUp(mark(), { pointerType: "touch" });
      act(() => { vi.advanceTimersByTime(3000); });
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
      // The click that ends a long press is not a tap; a quick tap after it is.
      fireEvent.click(mark());
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
      fireEvent.pointerDown(mark(), { pointerType: "touch", button: 0 });
      fireEvent.pointerUp(mark(), { pointerType: "touch" });
      fireEvent.click(mark());
      expect(screen.getByRole("tooltip")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a message that was not sent has a red mark that sends it again", async () => {
    const { user, engine } = bubble({ sender: "me", delivery: "failed", deliveryError: "The contact's app is closed" });
    act(() => engine.update({ links: [linkView()] }));
    engine.on("retryMessage", () => undefined);
    const red = screen.getByRole("button", { name: "Not sent. Send again" });
    expect(red).toHaveAttribute("data-delivery", "failed");
    expect(red.className).toContain("text-danger-ink");
    await user.hover(red);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Not sent. Tap to send again.");
    await user.click(red);
    expect(engine.callsTo("retryMessage")).toEqual([{ linkId: "link-1", messageId: "m1" }]);
  });

  it.each([
    ["64 items", "At most 64 items can wait for this contact. Wait until some are picked up.", "Your contact already has 64 items waiting. Send it again once they pick some up."],
    ["64 MB", "Items waiting for this contact would exceed 64 MB. Wait until some are picked up.", "This would put more than 64 MB waiting for your contact. Send it again once they pick some up."],
  ])("a held message with no room left in the contact's storage (%s) says why on its red mark, and again when a tap is refused", async (_, full, said) => {
    const { user, engine } = bubble({ sender: "me", delivery: "failed", deliveryError: full });
    act(() => engine.update({ links: [linkView()] }));
    engine.on("retryMessage", () => { throw new Error(full); });
    const red = screen.getByRole("button", { name: said });
    await user.hover(red);
    expect(screen.getByRole("tooltip")).toHaveTextContent(said);
    await user.unhover(red);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    await user.click(red);
    expect(engine.callsTo("retryMessage")).toHaveLength(1);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(said);
    // The mark said it: not a second time under the message.
    expect(screen.queryByTestId("message-retry-error")).not.toBeInTheDocument();
  });

  it("⋮ → Send again refused for a full storage says it under the message, where there is no mark to say it on", async () => {
    const full = "At most 64 items can wait for this contact. Wait until some are picked up.";
    const { user, engine } = bubble({ sender: "me", delivery: "failed", deliveryError: full });
    act(() => engine.update({ links: [linkView()] }));
    engine.on("retryMessage", () => { throw new Error(full); });
    await user.click(screen.getByTestId("message-options"));
    await user.click(screen.getByTestId("message-retry"));
    expect(await screen.findByTestId("message-retry-error-title")).toHaveTextContent("Your contact already has 64 items waiting");
    expect(screen.getByTestId("message-retry-error-next")).toHaveTextContent("Send it again once they pick some up.");
  });

  it("says a full storage in the person's language", () => {
    renderApp(<MessageBubble message={message({ sender: "me", delivery: "failed", deliveryError: "At most 64 items can wait for this contact. Wait until some are picked up." })} peerPubKey="peer" />, { language: "pt" });
    expect(screen.getByTestId("message-delivery")).toHaveAccessibleName("Seu contato já tem 64 itens esperando. Envie de novo quando seu contato pegar alguns.");
  });

  it("⋮ → Send again sends a message that was not sent; a sent one has no such row", async () => {
    const { user, engine, rerender } = bubble({ sender: "me", delivery: "failed" });
    act(() => engine.update({ links: [linkView()] }));
    engine.on("retryMessage", () => undefined);
    await user.click(screen.getByTestId("message-options"));
    await user.click(screen.getByTestId("message-retry"));
    expect(engine.callsTo("retryMessage")).toEqual([{ linkId: "link-1", messageId: "m1" }]);
    rerender(<MessageBubble message={message({ sender: "me", delivery: "sent" })} peerPubKey="peer" />);
    await user.click(screen.getByTestId("message-options"));
    expect(screen.queryByTestId("message-retry")).not.toBeInTheDocument();
    expect(screen.queryByTestId("message-cancel-sending")).not.toBeInTheDocument();
  });

  it("asks nothing of the person while a message is being sent again by itself", async () => {
    const { user } = bubble({ sender: "me", delivery: "queued", deliveryError: "Connection closed before receipt." });
    expect(screen.queryByRole("button", { name: "Not sent. Send again" })).not.toBeInTheDocument();
    await user.click(screen.getByTestId("message-options"));
    expect(screen.queryByTestId("message-retry")).not.toBeInTheDocument();
  });

  it("⋮ → Cancel sending drops what waits for your contact, in the place of Delete and with no confirmation", async () => {
    const { user, engine } = bubble({ sender: "me", delivery: "waiting", deliveryError: "Longer than the 256 bytes the DHT carries: it is sent when you are live." });
    act(() => engine.update({ links: [linkView()] }));
    engine.on("deleteMessage", () => undefined);
    await user.click(screen.getByTestId("message-options"));
    expect(screen.queryByTestId("message-retry")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel sending" }));
    expect(engine.callsTo("deleteMessage")).toEqual([{ linkId: "link-1", messageId: "m1" }]);
    expect(screen.queryByTestId("message-delete-menu")).not.toBeInTheDocument();
  });

  it("Cancel sending uses the chat's own delete where the chat gives one", async () => {
    const onDelete = vi.fn();
    const { user } = bubble({ sender: "me", delivery: "waiting" }, { onDelete });
    await user.click(screen.getByTestId("message-options"));
    expect(screen.queryByTestId("message-delete")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("message-cancel-sending"));
    expect(onDelete).toHaveBeenCalledOnce();
  });

  it("says why a Send again was refused under the message, in the app's words, until the message is sent", async () => {
    const { user, engine, rerender } = bubble({ sender: "me", delivery: "failed" });
    act(() => engine.update({ links: [linkView()] }));
    engine.on("retryMessage", () => { throw new Error("Held messages need S3 storage (Profile → Backups) and a contact that allows them."); });
    await user.click(screen.getByRole("button", { name: "Not sent. Send again" }));
    const notice = await screen.findByTestId("message-retry-error");
    expect(notice).toHaveAttribute("data-tone", "error");
    expect(screen.getByTestId("message-retry-error-title")).toHaveTextContent("This message can't be held");
    expect(screen.getByTestId("message-retry-error-next")).toHaveTextContent("Set up S3 storage in Profile → Backups, and ask your contact to allow held messages.");
    rerender(<MessageBubble message={message({ sender: "me", delivery: "sent" })} peerPubKey="peer" />);
    expect(screen.queryByTestId("message-retry-error")).not.toBeInTheDocument();
  });

  it("says why Cancel sending was refused", async () => {
    const { user, engine } = bubble({ sender: "me", delivery: "waiting" });
    act(() => engine.update({ links: [linkView()] }));
    engine.on("deleteMessage", () => { throw new Error("Chat not found"); });
    await user.click(screen.getByTestId("message-options"));
    await user.click(screen.getByTestId("message-cancel-sending"));
    expect(await screen.findByTestId("message-retry-error-title")).toHaveTextContent("Chat not found");
  });

  it("does not retry into a chat that is not there", async () => {
    const { user, engine } = bubble({ sender: "me", delivery: "failed" });
    await user.click(screen.getByRole("button", { name: "Not sent. Send again" }));
    expect(engine.callsTo("retryMessage")).toEqual([]);
  });

  it("a file of mine keeps its own mark while its bytes travel, and has the red mark (which sends it again) when they did not go", async () => {
    vi.spyOn(servicesPlatform!, "getFile").mockResolvedValue(null);
    const retryFile = vi.spyOn(servicesPlatform!, "retryFile").mockResolvedValue();
    const file = { id: "link-1-out-f", name: "report.pdf", size: 10, mime: "application/pdf" };
    const { user, engine } = bubble({ sender: "me", text: "report.pdf", file, delivery: "delivered" });
    act(() => engine.update({ transfers: { [file.id]: { state: "transferring", direction: "out", transferred: 2, size: 10 } } }));
    expect(mark()).toHaveAttribute("data-delivery", "delivered");
    act(() => engine.update({ transfers: { [file.id]: { state: "failed", direction: "out", transferred: 2, size: 10, error: "Connection lost", retry: true } } }));
    await user.click(screen.getByRole("button", { name: "Not sent. Send again" }));
    expect(retryFile).toHaveBeenCalledWith(file.id);
    // Declined: the message arrived, its file did not; the ticks stay and nothing is offered again.
    act(() => engine.update({ transfers: { [file.id]: { state: "failed", direction: "out", transferred: 0, size: 10, error: "Declined by your contact" } } }));
    expect(mark()).toHaveAttribute("data-delivery", "delivered");
  });

  it("says why the red mark could not send a file again", async () => {
    vi.spyOn(servicesPlatform!, "getFile").mockResolvedValue(null);
    vi.spyOn(servicesPlatform!, "retryFile").mockRejectedValue(new Error("This file is no longer here"));
    const file = { id: "link-1-out-f", name: "report.pdf", size: 10, mime: "application/pdf" };
    const { user, engine } = bubble({ sender: "me", text: "report.pdf", file, delivery: "delivered" });
    act(() => engine.update({ transfers: { [file.id]: { state: "failed", direction: "out", transferred: 2, size: 10, error: "Connection lost", retry: true } } }));
    await user.click(screen.getByRole("button", { name: "Not sent. Send again" }));
    expect(await screen.findByTestId("message-retry-error-title")).toHaveTextContent("This file is no longer here");
  });

  it("a file of mine whose copy into this device failed has the red mark, with nothing to send again", async () => {
    vi.spyOn(servicesPlatform!, "getFile").mockResolvedValue(null);
    const retryFile = vi.spyOn(servicesPlatform!, "retryFile").mockResolvedValue();
    const file = { id: "link-1-out-f", name: "film.mp4", size: 20_000_000, mime: "video/mp4" };
    // The row Chat.tsx adds at once, before the copy: no delivery state of its own.
    const { user, engine } = bubble({ sender: "me", text: "film.mp4", file });
    act(() => engine.update({ transfers: { [file.id]: { state: "failed", direction: "out", transferred: 0, size: file.size, error: "Not enough space on this device to send it", retry: false } } }));

    expect(mark()).toHaveAttribute("data-delivery", "failed");
    expect(mark()).toHaveAccessibleName("Not sent");
    expect(screen.queryByRole("button", { name: "Not sent. Send again" })).not.toBeInTheDocument();
    await user.click(mark());
    expect(screen.getByTestId("message-delivery-tip")).toHaveTextContent("Not sent");
    expect(screen.getByTestId("message-delivery-tip")).not.toHaveTextContent("send again");
    await user.click(screen.getByTestId("message-options"));
    expect(screen.queryByTestId("message-retry")).not.toBeInTheDocument();
    expect(retryFile).not.toHaveBeenCalled();
    expect(engine.callsTo("retryMessage")).toEqual([]);
  });

  it("marks a picture of mine on the dark chip over it, the same way", () => {
    bubble({ sender: "me", text: PNG, delivery: "waiting" });
    expect(mark().closest("[data-picture-time]")).not.toBeNull();
    expect(mark()).toHaveAccessibleName("Waiting for your contact to be online");
  });

  // The check mark: a second tick once the contact has it.
  const ticks = (container: HTMLElement) => container.querySelectorAll('[data-testid="message-delivery"] svg[viewBox="0 0 16 11"] path').length;

  it.each([
    ["delivered", { delivery: "delivered" }, 0, 2],
    ["sent, whatever the old acknowledgement says", { delivery: "sent" }, Number.MAX_SAFE_INTEGER, 1],
    ["acknowledged, without a delivery state", {}, 1_700_000_000_000, 2],
    ["not acknowledged yet", {}, 1_699_999_999_999, 1],
  ] as const)("ticks a message of mine %s", (_, patch, peerAck, count) => {
    const { container } = bubble({ sender: "me", ...patch }, { peerAck });
    expect(ticks(container)).toBe(count);
  });

  it("puts no tick on the contact's messages", () => {
    const { container } = bubble({}, { peerAck: Number.MAX_SAFE_INTEGER });
    expect(ticks(container)).toBe(0);
  });
});

describe("MessageBubble: deleting", () => {
  it("deletes only after the menu says it is only here", async () => {
    const onDelete = vi.fn();
    const { user } = bubble({ text: "oops" }, { onDelete });
    await user.click(screen.getByTestId("message-options"));
    await user.click(screen.getByRole("button", { name: "Delete message" }));
    expect(screen.getByTestId("message-delete-menu")).toHaveTextContent("Deleted only here. Your contact keeps their copy.");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("message-delete-menu")).not.toBeInTheDocument();
    expect(onDelete).not.toHaveBeenCalled();
    await user.click(screen.getByTestId("message-options"));
    await user.click(screen.getByRole("button", { name: "Delete message" }));
    await user.click(screen.getByTestId("message-delete-confirm"));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("message-delete-menu")).not.toBeInTheDocument();
  });

  it("a file still on its way says it stops, not that the contact keeps a copy; once here it does", async () => {
    vi.spyOn(servicesPlatform!, "getFile").mockResolvedValue(null);
    const moving = { state: "transferring" as const, transferred: 1_000_000, size: 30_000_000 };
    fakeEngine.update({ links: [linkView({ id: "link-1", peerPubKeyZ32: "peer" })], transfers: {
      "link-1-out-a": { ...moving, direction: "out" }, "link-1-in-b": { ...moving, direction: "in" }, "link-1-in-c": { state: "done", transferred: 30_000_000, size: 30_000_000 },
    } });
    const hint = async (patch: Partial<ChatMessage>) => {
      const view = bubble({ text: "f.bin", ...patch }, { onDelete: () => {} });
      await view.user.click(screen.getByTestId("message-options"));
      await view.user.click(screen.getByRole("button", { name: "Delete message" }));
      const words = screen.getByTestId("message-delete-menu").querySelector("p")!.textContent;
      view.unmount();
      return words;
    };
    const file = (id: string) => ({ id, name: "f.bin", size: 30_000_000, mime: "application/octet-stream" });
    expect(await hint({ id: "me_a", sender: "me", file: file("link-1-out-a") })).toBe("Deleted only here. Sending stops; your contact won't get the file.");
    expect(await hint({ id: "peer_b", file: file("link-1-in-b") })).toBe("Deleted only here. The file stops arriving; your contact sees it cancelled.");
    expect(await hint({ id: "peer_c", file: file("link-1-in-c") })).toBe("Deleted only here. Your contact keeps their copy.");
  });

  it("closes the menu on a click elsewhere", async () => {
    const onDelete = vi.fn();
    const { user } = renderApp(<><p>elsewhere</p><MessageBubble message={message({ sender: "me" })} onDelete={onDelete} /></>);
    await user.click(screen.getByTestId("message-options"));
    await user.click(screen.getByRole("button", { name: "Delete message" }));
    await user.click(screen.getByText("elsewhere"));
    expect(screen.queryByTestId("message-delete-menu")).not.toBeInTheDocument();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("draws the menu and the confirmation over the page, not inside the scrolling list", async () => {
    const { user, container } = renderApp(<div data-message-list><MessageBubble message={message({ sender: "me" })} onDelete={() => {}} /></div>);
    await user.click(screen.getByTestId("message-options"));
    expect(screen.getByTestId("message-menu").parentElement).toBe(document.body);
    await user.click(screen.getByRole("button", { name: "Delete message" }));
    expect(screen.getByTestId("message-delete-menu").parentElement).toBe(document.body);
    expect(container).not.toContainElement(screen.getByTestId("message-delete-menu"));
  });

  it("offers no delete where the chat cannot be edited", () => {
    bubble({ text: "kept" });
    expect(screen.queryByRole("button", { name: "Delete message" })).not.toBeInTheDocument();
  });
});
