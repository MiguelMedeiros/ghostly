import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageBubble } from "../../components/MessageBubble";
import { ChatFolderHeader } from "../../components/ChatFolderHeader";
import { servicesPlatform } from "../../lib/platform";
import type { ChatMessage } from "../../lib/types";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: app.menus

/**
 * One menu at a time, as a desktop's own menus: opening a message's menu (a right-click, its ⋮, the keyboard's menu
 * key) closes any other one open. A right-click opens its menu between the press and the release, so the menu open
 * before saw a newer layer over it at the release and stayed: three right-clicks left three menus open (Linux Desktop).
 */

const texts = ["first one", "second one", "third one"];
const message = (i: number): ChatMessage => ({ id: `me_${i}`, text: texts[i], sender: "me", timestamp: 1_700_000_000_000 + i, delivery: "delivered" });

function chat() {
  return renderApp(<div data-message-list>
    {texts.map((_, i) => <MessageBubble key={i} message={message(i)} peerPubKey="peer" onDelete={() => {}} onReply={() => {}} onPin={() => {}} onSave={() => {}} />)}
  </div>);
}

/** The message rows, in order, and the ⋮ of each. */
const rows = () => [...document.querySelectorAll<HTMLElement>("[data-message-row]")];
const dots = (i: number) => within(rows()[i]).getByTestId("message-options");
const menus = () => screen.queryAllByTestId("message-menu");

beforeEach(() => {
  fakeEngine.setState({ links: [linkView({ id: "link-1", peerPubKeyZ32: "peer" })] });
  vi.spyOn(servicesPlatform!, "getFile").mockResolvedValue(null);
});
afterEach(() => { vi.restoreAllMocks(); cleanup(); });

describe("a chat's message menus", () => {
  it("a right-click on one message, then on two others, leaves only the last one's menu open", async () => {
    const { user } = chat();
    for (const text of texts) await user.pointer({ keys: "[MouseRight]", target: screen.getByText(text) });
    expect(menus()).toHaveLength(1);
    expect(dots(2)).toHaveAttribute("aria-expanded", "true");
    expect([dots(0), dots(1)].map(b => b.getAttribute("aria-expanded"))).toEqual(["false", "false"]);
    // The focus is in the new menu, not given back to the ⋮ of a menu that closed.
    expect(screen.getByTestId("message-reply")).toHaveFocus();
    // Escape closes it, and with it the last menu: the focus goes to its own ⋮.
    await user.keyboard("{Escape}");
    expect(menus()).toHaveLength(0);
    expect(dots(2)).toHaveFocus();
  });

  it("a menu opened with no press (the keyboard's menu key, Shift+F10) closes the one open", () => {
    chat();
    for (const i of [0, 1, 2]) {
      dots(i).focus();
      fireEvent.contextMenu(dots(i));
    }
    expect(menus()).toHaveLength(1);
    expect(dots(2)).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("message-reply")).toHaveFocus();
  });

  it("a message's ⋮ menu, then a right-click on another message: one menu, the other's", async () => {
    const { user } = chat();
    await user.click(dots(0));
    expect(menus()).toHaveLength(1);
    await user.pointer({ keys: "[MouseRight]", target: screen.getByText("second one") });
    expect(menus()).toHaveLength(1);
    expect([dots(0), dots(1)].map(b => b.getAttribute("aria-expanded"))).toEqual(["false", "true"]);
    // And back: the first message's ⋮ closes the right-click's menu.
    await user.click(dots(0));
    expect(menus()).toHaveLength(1);
    expect([dots(0), dots(1)].map(b => b.getAttribute("aria-expanded"))).toEqual(["true", "false"]);
  });

  it("a right-click on one message then on a folder's header in the chat list: the header's menu alone", async () => {
    const { user } = renderApp(<>
      <ChatFolderHeader folder={{ id: "f1", name: "Work" }} sessions={[]} groups={[]} place={{ index: 0, count: 2 }} onToggle={() => {}} />
      <ChatFolderHeader folder={{ id: "f2", name: "Home" }} sessions={[]} groups={[]} place={{ index: 1, count: 2 }} onToggle={() => {}} />
      <div data-message-list><MessageBubble message={message(0)} peerPubKey="peer" onDelete={() => {}} onReply={() => {}} /></div>
    </>);
    await user.pointer({ keys: "[MouseRight]", target: screen.getByText("first one") });
    const [work, home] = screen.getAllByTestId("chat-folder-name");
    await user.pointer({ keys: "[MouseRight]", target: work });
    await user.pointer({ keys: "[MouseRight]", target: home });
    expect(menus()).toHaveLength(0);
    expect(screen.getAllByTestId("chat-folder-options-menu")).toHaveLength(1);
  });
});
