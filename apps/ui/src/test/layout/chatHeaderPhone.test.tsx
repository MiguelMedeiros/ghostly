import "fake-indexeddb/auto";
import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readStatusCard, statusCardText } from "@ghostly/core";
import { Chat } from "../../pages/Chat";
import { saveSession } from "../../lib/storage";
import type { ChatMessage } from "../../lib/types";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: app.mobile-layout, app.menus, chat.status-cards

/**
 * A chat's header on a phone held upright: the name, the connection, a voice call and ⋮. The video call and the
 * contact's identities were a button and marks beside the name, which was cut to eight letters; they are rows of ⋮ now.
 * The connection stays in the row: it changes by itself, and a failure has to be seen without opening a menu.
 */

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {} }));

const PEER = "peer".padEnd(52, "p");
/** How wide the window is, as matchMedia reads it. */
const viewport = (width: number, height = 800) => (window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM.setViewport({ width, height });
afterEach(() => viewport(1024, 768));

function openChat() {
  saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", label: "Cérebro (Mac)", messages: [], createdAt: 1_700_000_000_000 });
  const utils = renderApp(<Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} />);
  utils.engine.on("ensureLink", () => ({ linkId: "link-1" })).on("setActiveLink", () => undefined).on("sendMessage", () => ({ error: null }));
  utils.engine.update({ links: [linkView({ peerPubKeyZ32: PEER, profile: "paired-chat/1", pairing: { status: "ready" } } as never)] });
  return utils;
}

const MOVED = ["call-video", "chat-identity-badges"];

describe("a chat's header on a phone", () => {
  it("keeps the name, the connection, a voice call and ⋮, and has the rest as rows of ⋮", async () => {
    viewport(390, 844);
    const { user } = openChat();
    const options = await screen.findByTestId("chat-options");
    expect(screen.getByTestId("chat-name")).toHaveTextContent("Cérebro (Mac)");
    for (const id of ["connection-options", "call-audio"]) expect(screen.getByTestId(id), id).toBeInTheDocument();
    for (const id of MOVED) expect(screen.queryByTestId(id), id).not.toBeInTheDocument();

    await user.click(options);
    const menu = within(screen.getByTestId("chat-options-menu"));
    for (const id of MOVED) expect(menu.getByTestId(id), id).toHaveAttribute("data-menu-item");
    // The connection is not a row of it: it is the header's own button, and says its state.
    expect(menu.queryByTestId("connection-options")).not.toBeInTheDocument();
    expect(screen.getByTestId("connection-options")).toHaveAccessibleName(/^Connection options: ./);
    expect(menu.getByTestId("chat-identity-badges")).toHaveTextContent("Identities with Cérebro (Mac)");
  });

  it("says on the ⋮ row why a video call cannot start, as the voice call says it to a screen reader", async () => {
    viewport(390, 844);
    const { user } = openChat();
    const voice = await screen.findByTestId("call-audio");
    const reason = voice.getAttribute("title") ?? "";
    expect(reason, "the chat cannot call here").not.toBe("Audio call");
    expect(voice).toHaveAttribute("aria-disabled", "true");
    expect(voice).toHaveAccessibleDescription(reason);

    await user.click(screen.getByTestId("chat-options"));
    const row = within(screen.getByTestId("chat-options-menu")).getByTestId("call-video");
    expect(row).toBeDisabled();
    // A phone has no hover: the reason is the row's second line, not only its title.
    expect(row).toHaveTextContent(`Video call${reason}`);
  });

  it("opens the connection's panel from its button in the header, and gives the focus back to it as it closes", async () => {
    viewport(390, 844);
    const { user } = openChat();
    const control = await screen.findByTestId("connection-options");
    await user.click(control);
    const panel = screen.getByTestId("connection-menu");
    expect(panel).toHaveAttribute("open");
    await user.keyboard("{Escape}");
    expect(panel).not.toHaveAttribute("open");
    expect(document.activeElement).toBe(control);
  });

  it("wider than a phone, every button is in the header as before", async () => {
    viewport(1024, 768);
    openChat();
    await screen.findByTestId("chat-options");
    for (const id of ["connection-options", "call-audio", ...MOVED]) expect(screen.getByTestId(id), id).toBeInTheDocument();
  });
});

/** The menu's rows and separators top to bottom: a row by its test id (or its text), a separator as "—". */
const layout = (menu: HTMLElement) => [...menu.querySelectorAll<HTMLElement>("[data-menu-item], [role=separator]")]
  .map(el => el.getAttribute("role") === "separator" ? "—" : el.dataset.testid ?? el.textContent);

describe("a chat's ⋮ menu, in groups", () => {
  it("on a phone: the actions, the conversation, More…, and Delete chat apart; no Move up or Move down", async () => {
    viewport(390, 844);
    const { user } = openChat();
    await user.click(await screen.findByTestId("chat-options"));
    const menu = screen.getByTestId("chat-options-menu");
    expect(menu).toHaveAttribute("data-menu", "sheet");
    expect(layout(menu)).toEqual(["call-video", "chat-search-open", "chat-mute-open", "chat-pin-toggle", "—", "chat-identity-badges", "—", "chat-more-open", "—", "Delete chat"]);
    expect(within(menu).getByTestId("chat-more-open")).toHaveTextContent("More…");
    // Without a bot's task going, no Tasks row and no count on ⋮.
    expect(within(menu).queryByTestId("chat-tasks")).not.toBeInTheDocument();
    expect(screen.queryByTestId("chat-tasks-count")).not.toBeInTheDocument();
  });

  it("More… opens a second sheet with the rarer rows, focused on its first; Escape gives the focus back to ⋮", async () => {
    viewport(390, 844);
    const { user } = openChat();
    const options = await screen.findByTestId("chat-options");
    await user.click(options);
    await user.click(screen.getByTestId("chat-more-open"));
    expect(screen.queryByTestId("chat-options-menu")).not.toBeInTheDocument();
    const more = screen.getByTestId("chat-more-menu");
    expect(more).toHaveAttribute("data-menu", "sheet");
    expect(more).toHaveAccessibleName("More options");
    expect(layout(more).filter(row => row !== "chat-hold-open")).toEqual(["chat-folder-open", "chat-refresh", "chat-tech-info"]);
    expect(within(more).getByTestId("chat-folder-open")).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("chat-more-menu")).not.toBeInTheDocument();
    expect(options).toHaveFocus();

    // A row of it does what it did in the one long list: Tech Info opens, and the sheet is gone.
    await user.click(options);
    await user.click(screen.getByTestId("chat-more-open"));
    await user.click(screen.getByTestId("chat-tech-info"));
    expect(screen.queryByTestId("chat-more-menu")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Tech Info" })).toBeInTheDocument();
  });

  it("on a wide screen: the same order in one popover, with no More…", async () => {
    viewport(1024, 768);
    const { user } = openChat();
    await user.click(await screen.findByTestId("chat-options"));
    const menu = screen.getByTestId("chat-options-menu");
    expect(menu).toHaveAttribute("data-menu", "popover");
    expect(layout(menu).filter(row => row !== "chat-hold-open")).toEqual(["chat-search-open", "chat-mute-open", "chat-pin-toggle", "—", "chat-folder-open", "chat-refresh", "chat-tech-info", "—", "Delete chat"]);
  });
});

// agents#1704: a chat kept loaded (on a call) when another opens closes what it opened over the page.
describe("a chat that goes off screen", () => {
  it("closes its Tech Info, which does not stay over the chat opened", async () => {
    viewport(1024, 768);
    const { user, rerender } = openChat();
    await user.click(await screen.findByTestId("chat-options"));
    await user.click(screen.getByTestId("chat-tech-info"));
    expect(screen.getByRole("heading", { name: "Tech Info" })).toBeInTheDocument();
    rerender(<Chat sessionId="chat-1" visible={false} onCallChange={() => {}} callLayer={null} />);
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Tech Info" })).not.toBeInTheDocument());
  });
});

describe("a bot's Tasks in a phone's ⋮", () => {
  const cardMessage = (id: string, card: Record<string, unknown>): ChatMessage => {
    const c = readStatusCard(card)!;
    return { id, text: statusCardText(c), sender: "peer", timestamp: 1_700_000_000_000 + Number(id.slice(1)), card: c };
  };
  function openWith(messages: ChatMessage[]) {
    saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", label: "Cérebro (Mac)", messages, createdAt: 1_700_000_000_000 });
    const utils = renderApp(<Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} />);
    utils.engine.on("ensureLink", () => ({ linkId: "link-1" })).on("setActiveLink", () => undefined).on("sendMessage", () => ({ error: null }));
    utils.engine.update({ links: [linkView({ peerPubKeyZ32: PEER, profile: "paired-chat/1", pairing: { status: "ready" } } as never)] });
    return utils;
  }
  const finished = cardMessage("m1", { kind: "task", id: "done", title: "Shipped", status: "done" });
  const paused = cardMessage("m2", { kind: "routine", id: "weekly", name: "Weekly", schedule: "every week", state: "paused" });

  it("counts on ⋮ only the tasks going and the routines not paused, and has Tasks with that count under the conversation", async () => {
    viewport(390, 844);
    const running = cardMessage("m3", { kind: "task", id: "relay", title: "Fix relay", status: "running" });
    const nightly = cardMessage("m4", { kind: "routine", id: "nightly", name: "Nightly", schedule: "every day 01:00", state: "active" });
    const { user } = openWith([finished, paused, running, nightly]);
    expect(await screen.findByTestId("chat-tasks-count")).toHaveTextContent("2");
    await user.click(screen.getByTestId("chat-options"));
    const menu = screen.getByTestId("chat-options-menu");
    expect(layout(menu).slice(4, 8)).toEqual(["—", "chat-identity-badges", "chat-tasks", "—"]);
    expect(within(menu).getByTestId("chat-tasks")).toHaveTextContent("Tasks, 2 active");
    await user.click(within(menu).getByTestId("chat-tasks"));
    expect(screen.getByTestId("chat-tasks-panel")).toBeInTheDocument();
  });

  it("has no Tasks row and no count when the cards are only finished tasks and paused routines", async () => {
    viewport(390, 844);
    const { user } = openWith([finished, paused]);
    await screen.findAllByTestId("status-card");
    expect(screen.queryByTestId("chat-tasks-count")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("chat-options"));
    expect(within(screen.getByTestId("chat-options-menu")).queryByTestId("chat-tasks")).not.toBeInTheDocument();
  });
});

describe("a chat's Tech Info", () => {
  it("is a dialog for the keyboard: the focus goes in, Tab stays in it, Escape closes it and gives the focus back to ⋮", async () => {
    viewport(390, 844);
    const { user } = openChat();
    const options = await screen.findByTestId("chat-options");
    await user.click(options);
    await user.click(screen.getByTestId("chat-more-open"));
    await user.click(screen.getByTestId("chat-tech-info"));
    const dialog = screen.getByRole("dialog", { name: "Tech Info" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog.contains(document.activeElement)).toBe(true);
    for (let i = 0; i < 6; i++) {
      await user.tab();
      expect(dialog.contains(document.activeElement), `Tab ${i + 1}`).toBe(true);
    }
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Tech Info" })).not.toBeInTheDocument();
    expect(options).toHaveFocus();
  });

  it("closed by its ✕, on a wide screen too, gives the focus back to ⋮", async () => {
    viewport(1024, 768);
    const { user } = openChat();
    const options = await screen.findByTestId("chat-options");
    await user.click(options);
    await user.click(screen.getByTestId("chat-tech-info"));
    const dialog = screen.getByRole("dialog", { name: "Tech Info" });
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "Tech Info" })).not.toBeInTheDocument();
    expect(options).toHaveFocus();
  });

  /** Tech Info of a chat whose link is open, polled every 59.996 s, in `language`. */
  async function techInfo(language: "ar" | "en") {
    viewport(1024, 768);
    saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", label: "Cérebro (Mac)", messages: [], createdAt: 1_700_000_000_000 });
    const { user, engine } = renderApp(<Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} />, { language });
    engine.on("ensureLink", () => ({ linkId: "link-1" })).on("setActiveLink", () => undefined).on("sendMessage", () => ({ error: null }));
    engine.update({ links: [linkView({ peerPubKeyZ32: PEER, profile: "paired-chat/1", pairing: { status: "ready" }, status: "online", poll: { polling: false, nextAt: 0, interval: 59_996 } } as never)] });
    await user.click(await screen.findByTestId("chat-options"));
    await user.click(screen.getByTestId("chat-tech-info"));
    // The connection's panel is a dialog too; Tech Info is the modal one.
    return screen.getAllByRole("dialog").find(dialog => dialog.getAttribute("aria-modal") === "true")!;
  }

  // agents#1701: the status was the engine's English word and the network line English in every language.
  it("says the status and the network in the reader's language", async () => {
    const dialog = await techInfo("ar");
    expect(dialog).toHaveTextContent("الحالة" + "متصل");
    expect(dialog.textContent).not.toMatch(/online|peer to peer|for discovery/);
    expect(dialog).toHaveTextContent("WebRTC DataChannel");
  });

  // agents#1701: Polls, My ACK and Pending were constants (0, none, 0) the engine never filled.
  it("shows no row the engine has no value for, and the poll interval in whole seconds", async () => {
    const dialog = await techInfo("en");
    expect(dialog).toHaveTextContent("Statusonline");
    expect(dialog).toHaveTextContent("NetworkWebRTC DataChannel (peer to peer) · Pkarr for discovery");
    expect(dialog).toHaveTextContent("Poll Interval60s");
    for (const gone of ["Polls", "My ACK", "Pending"]) expect(dialog.textContent, gone).not.toContain(gone);
    expect(dialog).toHaveTextContent("Peer ACK");
  });
});
