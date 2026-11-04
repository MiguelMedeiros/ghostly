import { screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Route, Routes, useLocation } from "react-router-dom";
import type { InstalledAppView } from "@ghostly/browser/engine/apps";
import { AppChatPicker } from "../../components/apps/AppChatPicker";
import { takeOpenRequest } from "../../lib/apps/running";
import { saveSession } from "../../lib/storage";
import type { ChatSession } from "../../lib/types";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: apps.page

const KEY = "yz7moxucbd4u8aqtk5ir8khn4emft7zskr7qo7x876ntwxfiegoo";
const REF = `${KEY}/chess`;
const chess: InstalledAppView = {
  ref: REF, name: "chess", publisher: KEY, fingerprint: "yz7m oxuc bd4u 8aqt", title: "Chess", tagline: "Play chess with a contact", version: "1.2.0",
  sequence: 7, digest: "ExPDNDfgZ_QT1mf4KwxD-xeFAYukL50YWZ1YuFsKkp4", permissions: ["chat"], view: "chat", from: "https://raw.githubusercontent.com/ana/chess/HEAD/app.ghostlyapp",
  icon: false, installedAt: 1, updatedAt: 1, run: { status: "ok" }, listedBy: [], unknownPublisher: false,
};

/** A paired 1:1 chat with its link, last spoken in at `last`. */
function paired(slug: string, nick: string, last: number) {
  saveSession({ id: `chat-${slug}`, mySeedB64: "s", peerPubKeyB64: `peer-${slug}`, encKeyB64: "e", nick, profile: "paired-chat/1", createdAt: 1,
    messages: [{ id: "x", text: "hi", sender: "peer", timestamp: last }] } as unknown as ChatSession);
  return linkView({ id: `link-${slug}`, peerPubKeyZ32: `peer-${slug}`, profile: "paired-chat/1" });
}

function Where() { return <p data-testid="where">{useLocation().pathname}</p>; }

const open = () => renderApp(<Routes>
  <Route path="/apps" element={<AppChatPicker app={chess} onClose={() => {}} />} />
  <Route path="*" element={<Where />} />
</Routes>, { route: "/apps" });
const names = () => screen.getAllByTestId("app-chat-picker-chat").map(row => row.querySelector("bdi")?.textContent);

describe("Open an app in a chat: which chat, found by name", () => {
  beforeEach(() => {
    // Thirty contacts spoken to lately, and Zoe long ago: the last of the list, well past a phone's screen.
    const links = Array.from({ length: 30 }, (_, i) => paired(`c${i}`, `Contact ${String(i + 1).padStart(2, "0")}`, 10_000 - i));
    links.push(paired("zoe", "Zoe", 100));
    fakeEngine.update({ links });
  });
  afterEach(() => { takeOpenRequest("link-zoe"); });

  it("has Forward's search at the top, with the focus on it, and finds a chat by name", async () => {
    const { user } = open();
    const search = screen.getByTestId("app-chat-picker-search");
    expect(search).toHaveAccessibleName("Search chats");
    expect(search).toHaveFocus();
    expect(names()).toHaveLength(31);
    expect(names()[30]).toBe("Zoe");
    await user.keyboard("zO");
    expect(names()).toEqual(["Zoe"]);
    await user.keyboard("x");
    expect(screen.queryByTestId("app-chat-picker-chat")).not.toBeInTheDocument();
    expect(screen.getByTestId("app-chat-picker-no-match")).toHaveTextContent("No chat by that name");
    await user.clear(search);
    expect(names()).toHaveLength(31);
  });

  it("the down arrow (or Tab) goes from the search to the chats found, and Enter opens the app there", async () => {
    const { user } = open();
    await user.keyboard("zoe");
    await user.keyboard("{ArrowDown}");
    const zoe = within(screen.getByTestId("app-chat-picker")).getByTestId("app-chat-picker-chat");
    expect(zoe).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(screen.getByTestId("app-chat-picker-search")).toHaveFocus();
    await user.tab();
    expect(zoe).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.getByTestId("where")).toHaveTextContent("chat-zoe");
    expect(takeOpenRequest("link-zoe")?.app.ref).toBe(REF);
  });

  it("the arrows move from chat to chat in the whole list", async () => {
    const { user } = open();
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(screen.getAllByTestId("app-chat-picker-chat")[1]).toHaveFocus();
    await user.keyboard("{End}");
    expect(screen.getAllByTestId("app-chat-picker-chat")[30]).toHaveFocus();
    await user.keyboard("{Home}");
    expect(screen.getAllByTestId("app-chat-picker-chat")[0]).toHaveFocus();
  });
});

describe("Open an app in a chat with no paired chat", () => {
  it("says so, with no search over nothing", () => {
    fakeEngine.update({ links: [] });
    open();
    expect(screen.getByTestId("app-chat-picker-none")).toBeInTheDocument();
    expect(screen.queryByTestId("app-chat-picker-search")).not.toBeInTheDocument();
  });
});
