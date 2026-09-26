import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LinkPreview } from "@ghostly/core";
import { MessageInput } from "../../components/MessageInput";
import { MessageBubble } from "../../components/MessageBubble";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { forgetLinkPreviews } from "../../lib/linkPreviewFetch";
import { renderApp } from "../render";

// covers: chat.link-preview.compose, chat.link-preview.render, chat.location.card

/** A JPEG data URL with a real frame header (320×180), as the sender's app would send. */
const thumbnail = (() => {
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, 0, 180, 1, 64, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return "data:image/jpeg;base64," + btoa(String.fromCharCode(0xff, 0xd8, ...sof, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9));
})();

const ogPage = `<html><head><title>fallback</title>
  <meta property="og:title" content="Ghosts are real">
  <meta property="og:description" content="A story about peer-to-peer chat">
  <meta property="og:site_name" content="Example News">
</head><body></body></html>`;

/** Sites that answer with Open Graph tags (and allow it, as CORS would); every request is recorded. */
function sites() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(ogPage, { headers: { "content-type": "text/html; charset=utf-8" } }));
}

const onSend = vi.fn<(text: string, mentions?: unknown, extra?: { preview?: LinkPreview }) => Promise<string | null>>();
const composer = (linkPreviews = true) =>
  renderApp(<LockScreenProvider><MessageInput onSend={onSend} linkPreviews={linkPreviews} /></LockScreenProvider>);
const field = () => screen.getByPlaceholderText<HTMLTextAreaElement>("Message…");
const type = (text: string) => fireEvent.change(field(), { target: { value: text } });
const send = () => fireEvent.click(screen.getByRole("button", { name: "Send message" }));

beforeEach(() => { onSend.mockReset().mockResolvedValue(null); forgetLinkPreviews(); });
afterEach(() => { vi.restoreAllMocks(); });

describe("a link preview in the composer", () => {
  it("is read from the page once the text rests, shown, and sent with the message", async () => {
    const fetch = sites();
    composer();
    type("look https://news.example/story?utm_source=feed&id=9");
    const card = await screen.findByTestId("composer-link-preview");
    await waitFor(() => expect(card).toHaveAttribute("data-status", "ready"));
    expect(within(card).getByTestId("composer-link-preview-title")).toHaveTextContent("Ghosts are real");
    // The tracking parameter is not in what was asked, nor in what is sent.
    expect(fetch).toHaveBeenCalledOnce();
    expect(String(fetch.mock.calls[0][0])).toBe("https://news.example/story?id=9");
    expect(fetch.mock.calls[0][1]).toMatchObject({ credentials: "omit", referrerPolicy: "no-referrer" });
    send();
    await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
    expect(onSend).toHaveBeenCalledWith("look https://news.example/story?utm_source=feed&id=9", undefined, {
      preview: { u: "https://news.example/story?id=9", t: "Ghosts are real", d: "A story about peer-to-peer chat", s: "Example News" },
    });
    await waitFor(() => expect(screen.queryByTestId("composer-link-preview")).toBeNull());
  });

  it("can be removed: the link then goes as plain text, and is not read again in that draft", async () => {
    const fetch = sites();
    composer();
    type("https://news.example/a");
    await waitFor(() => expect(screen.getByTestId("composer-link-preview")).toHaveAttribute("data-status", "ready"));
    fireEvent.click(screen.getByTestId("link-preview-remove"));
    expect(screen.queryByTestId("composer-link-preview")).toBeNull();
    type("https://news.example/a and more");
    await new Promise(resolve => setTimeout(resolve, 800));
    expect(screen.queryByTestId("composer-link-preview")).toBeNull();
    send();
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("https://news.example/a and more", undefined));
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("asks nothing when previews are off, for local addresses, or when the site does not allow it", async () => {
    const fetch = sites();
    const view = composer(false);
    type("https://news.example/a");
    await new Promise(resolve => setTimeout(resolve, 800));
    expect(screen.queryByTestId("composer-link-preview")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    view.unmount();

    composer();
    type("my router http://192.168.0.1/ and http://printer.local/");
    await new Promise(resolve => setTimeout(resolve, 800));
    expect(fetch).not.toHaveBeenCalled();
    // CORS refused: the fetch fails as a network error does, and there is simply no card.
    fetch.mockRejectedValue(new TypeError("Failed to fetch"));
    type("https://closed.example/page");
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByTestId("composer-link-preview")).toBeNull());
    send();
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("https://closed.example/page", undefined));
  });
});

describe("a link preview in a message", () => {
  const preview: LinkPreview = { u: "https://news.example/story?id=9", t: "Ghosts are real", d: "A story", s: "Example News", i: thumbnail };

  it("is drawn from the message alone, and opens the link outside the app", () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    renderApp(<MessageBubble message={{ id: "m1", text: "look https://news.example/story?utm_source=x&id=9", sender: "peer", timestamp: 1_700_000_000_000, preview }} />);
    const card = screen.getByTestId("link-preview-card");
    expect(card).toHaveAttribute("href", "https://news.example/story?id=9");
    expect(card).toHaveAttribute("target", "_blank");
    expect(card).toHaveAttribute("rel", "noopener noreferrer");
    expect(within(card).getByTestId("link-preview-title")).toHaveTextContent("Ghosts are real");
    expect(within(card).getByTestId("link-preview-site")).toHaveTextContent("Example News");
    // The picture is the sender's own copy: a data URL, never the site's address.
    expect(within(card).getByTestId("link-preview-image")).toHaveAttribute("src", thumbnail);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("draws YouTube and Vimeo as a video card, with nothing embedded", () => {
    const { container } = renderApp(<MessageBubble message={{ id: "m2", text: "https://youtu.be/dQw4w9WgXcQ", sender: "me", timestamp: 1_700_000_000_000,
      preview: { u: "https://youtu.be/dQw4w9WgXcQ", t: "A video", s: "YouTube", i: thumbnail } }} />);
    expect(screen.getByTestId("link-preview-card")).toHaveAttribute("data-video", "youtube");
    expect(container.querySelector("iframe, video, embed, object")).toBeNull();
  });

  it("shows nothing extra for a message without a preview or a place", () => {
    renderApp(<MessageBubble message={{ id: "m3", text: "https://news.example/story", sender: "peer", timestamp: 1_700_000_000_000 }} />);
    expect(screen.queryByTestId("message-link-cards")).toBeNull();
  });
});

describe("a location card", () => {
  it("reads the place from the text, and loads the map from OpenStreetMap only on tap", () => {
    const { container } = renderApp(<MessageBubble message={{ id: "m4", text: "here: geo:0,0?q=38.6916,-9.2160(Torre%20de%20Bel%C3%A9m)", sender: "peer", timestamp: 1_700_000_000_000 }} />);
    const card = screen.getByTestId("location-card");
    expect(within(card).getByTestId("location-name")).toHaveTextContent("Torre de Belém");
    expect(within(card).getByTestId("location-coordinates")).toHaveTextContent("38.69160, -9.21600");
    expect(card).toHaveTextContent("OpenStreetMap, which then sees your IP address");
    expect(container.querySelector("img[src*='openstreetmap']")).toBeNull();
    fireEvent.click(within(card).getByTestId("location-show-map"));
    const tiles = [...within(card).getByTestId("location-map").querySelectorAll("img")];
    expect(tiles).toHaveLength(4);
    for (const tile of tiles) expect(tile.getAttribute("src")).toMatch(/^https:\/\/tile\.openstreetmap\.org\/15\/\d+\/\d+\.png$/);
    expect(within(card).getByTestId("location-open").getAttribute("href")).toMatch(/^(https:\/\/maps\.apple\.com\/|geo:|https:\/\/www\.openstreetmap\.org\/)/);
  });

  it("comes from a map link too", () => {
    renderApp(<MessageBubble message={{ id: "m5", text: "https://www.openstreetmap.org/?mlat=38.6916&mlon=-9.2160#map=16/38.6916/-9.2160", sender: "me", timestamp: 1_700_000_000_000 }} />);
    expect(screen.getByTestId("location-coordinates")).toHaveTextContent("38.69160, -9.21600");
    expect(screen.getByTestId("location-name")).toHaveTextContent("Location");
  });
});
