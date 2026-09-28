import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageBubble } from "../../components/MessageBubble";
import type { ChatMessage } from "../../lib/types";
import { renderApp } from "../render";

// covers: chat.paired.links, chat.rich.mdlinks

/*
 * A link in a message opens outside the app on every platform. A browser page opens a new tab from the link itself;
 * the Desktop WebView opens none (WKWebView, as Tauri sets it up, drops a new-window request), so there the link hands
 * the address to the system browser (`open_web_link`). Found from a message whose links did not open in the macOS app.
 */

const tauri = vi.hoisted(() => ({ invoke: vi.fn(async (_command: string, _args?: unknown): Promise<unknown> => undefined) }));
// The UI tests alias every `@tauri-apps/api/*` to one stand-in (packages/browser/src/platform/tauri.ts): one mock.
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke, listen: async () => () => {}, getVersion: async () => "0.4.0" }));

/** The message that reached the macOS app, as `ghostly send --stdin` sent it. */
const REPORTED = `O GitHub não tem página de fila pra repo de usuário (só pra org). O que dá pra ver:
• PRs abertos no dev: https://github.com/MiguelMedeiros/ghostly/pulls?q=is%3Apr+is%3Aopen+base%3Adev
  Os armados mostram "Auto-merge enabled" na página do PR, e o merge box diz o que falta (CI ou atualizar).
• A regra do dev: https://github.com/MiguelMedeiros/ghostly/settings/rules/24090296
A ordem mesmo fica no meu loop aqui. Agora: #408 (CI rodando) → #405 → #411. #394 e #402 esperando rebase.`;
const PULLS = "https://github.com/MiguelMedeiros/ghostly/pulls?q=is%3Apr+is%3Aopen+base%3Adev";
const RULES = "https://github.com/MiguelMedeiros/ghostly/settings/rules/24090296";

const SENT = Date.UTC(2026, 8, 27, 12);
const bubble = (text: string) =>
  renderApp(<MessageBubble message={{ id: "m1", text, sender: "peer", timestamp: SENT } satisfies ChatMessage} peerPubKey="peer" />);
const links = () => within(screen.getByTestId("message-text")).getAllByRole("link");
/** Clicks `link` as a mouse does; true when the page kept the browser from following it. */
const click = (link: HTMLElement) => !fireEvent.click(link, { button: 0 });

const setDesktop = (on: boolean) => {
  const w = window as unknown as { __TAURI_INTERNALS__?: object };
  if (on) w.__TAURI_INTERNALS__ = {};
  else delete w.__TAURI_INTERNALS__;
};
beforeEach(() => tauri.invoke.mockClear());
afterEach(() => setDesktop(false));

describe("links in a message", () => {
  it("show both addresses of the reported message as links, safe to follow", () => {
    bubble(REPORTED);
    const [pulls, rules] = links();
    expect(links()).toHaveLength(2);
    expect(pulls).toHaveAttribute("href", PULLS);
    expect(pulls).toHaveTextContent(PULLS);
    expect(rules).toHaveAttribute("href", RULES);
    for (const link of [pulls, rules]) {
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
      expect(link).toHaveAttribute("referrerpolicy", "no-referrer");
      expect(link).toHaveAttribute("dir", "ltr");
    }
  });

  it("open in a new tab on the web: the link itself does it", () => {
    bubble(REPORTED);
    for (const link of links()) expect(click(link)).toBe(false);
    expect(tauri.invoke).not.toHaveBeenCalled();
  });

  it("open in the system browser on Desktop, whose WebView opens no new tab", () => {
    setDesktop(true);
    bubble(REPORTED);
    for (const link of links()) expect(click(link)).toBe(true);
    expect(tauri.invoke.mock.calls).toEqual([["open_web_link", { url: PULLS }], ["open_web_link", { url: RULES }]]);
  });

  it("open [text](url) links in the system browser on Desktop too, text or address shown", () => {
    setDesktop(true);
    bubble("see [the docs](https://ghostly.tools/docs) and [ghostly.tools](https://evil.example/login)");
    const [docs, shown] = links();
    expect(shown).toHaveAttribute("data-shows", "url");
    expect(click(docs)).toBe(true);
    expect(click(shown)).toBe(true);
    expect(tauri.invoke.mock.calls).toEqual([
      ["open_web_link", { url: "https://ghostly.tools/docs" }],
      ["open_web_link", { url: "https://evil.example/login" }],
    ]);
  });
});
