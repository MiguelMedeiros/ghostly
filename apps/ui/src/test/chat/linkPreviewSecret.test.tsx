import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LinkPreview } from "@ghostly/core";
import { MessageInput } from "../../components/MessageInput";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { forgetLinkPreviews } from "../../lib/linkPreviewFetch";
import { PREVIEW_DEBOUNCE_MS } from "../../hooks/useLinkPreviewDraft";
import { previewableLink } from "../../lib/parse/linkPreview";
import { findSecret } from "../../lib/parse/secrets";
import { renderApp } from "../render";

// covers: chat.link-preview.compose

const CASHU = "cashuBo2FtcGh0dHA6Ly9taW50LnRlc3RhdWNzYXRhdIGiYWlIAJofKTJT5B5hcIKjYWEIYXNtdGVzdC1zZWNyZXQtYWFjWCECERERERERERERERERERERERERERERERERERERERERERGjYWENYXNtdGVzdC1zZWNyZXQtYmFjWCECIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI";
const NSEC = "nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5";

/** Links whose address holds what the secret guard asks about before a message goes. */
const SECRET_LINKS = [
  `https://wallet.cashu.me/?token=${CASHU}`,
  `here: https://example.com/redeem?token=${CASHU}`,
  `https://example.com/login?nsec=${NSEC}`,
];

const ogPage = `<html><head><meta property="og:title" content="Ghosts are real"></head><body></body></html>`;
const sites = () => vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(ogPage, { headers: { "content-type": "text/html; charset=utf-8" } }));

const onSend = vi.fn<(text: string, mentions?: unknown, extra?: { preview?: LinkPreview }) => Promise<string | null>>();
const composer = () => renderApp(<LockScreenProvider><MessageInput onSend={onSend} linkPreviews /></LockScreenProvider>);
const type = (text: string) => fireEvent.change(screen.getByPlaceholderText<HTMLTextAreaElement>("Message…"), { target: { value: text } });

describe("a link preview of a link that holds a secret", () => {
  beforeEach(() => {
    onSend.mockReset().mockResolvedValue(null);
    forgetLinkPreviews();
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  const rest = () => act(() => vi.advanceTimersByTimeAsync(PREVIEW_DEBOUNCE_MS + 100));

  it("is not made: the link is not one a preview is read for", () => {
    for (const text of SECRET_LINKS) {
      expect(findSecret(text)).not.toBeNull();
      expect(previewableLink(text)).toBeNull();
    }
    expect(previewableLink("https://news.example/story?id=9")).toBe("https://news.example/story?id=9");
  });

  it("goes to the next link of the text when that one holds none", () => {
    expect(previewableLink(`${SECRET_LINKS[0]} and https://news.example/story`)).toBe("https://news.example/story");
  });

  it.each(SECRET_LINKS)("asks nothing of the site and shows no card in the composer: %s", async (text) => {
    const fetch = sites();
    composer();
    type(text);
    await rest();
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.queryByTestId("composer-link-preview")).not.toBeInTheDocument();
  });

  it("still reads a clean link's page", async () => {
    const fetch = sites();
    composer();
    type("look https://news.example/story?id=9");
    await rest();
    const card = await screen.findByTestId("composer-link-preview");
    await waitFor(() => expect(card).toHaveAttribute("data-status", "ready"));
    expect(fetch).toHaveBeenCalledOnce();
    expect(String(fetch.mock.calls[0][0])).toBe("https://news.example/story?id=9");
  });
});
